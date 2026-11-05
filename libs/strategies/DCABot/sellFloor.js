'use strict';

// Pure, dependency-free decision logic for the slippage-safe graceful close.
//
// THE PROBLEM (prod 2026-10-03/04): a large market sell on a thin pair partial-fills near target, then the
// remainder is re-sold into a walked-down order book with NO lower bound, locking in a loss BELOW break-even
// (ROBO/KAIO). The take-profit only fires at/above target, so a remainder that can no longer meet the floor
// means the market dropped AFTER the trigger — exactly the moment selling is wrong.
//
// THE FIX, in pure form: a best-bid FLOOR GATE. Before each (re)sell attempt, compare the current best bid to
// the floor (break-even net of fees, or target minus a configured give-back). If the bid is at/above the
// floor, allow the sell; otherwise HOLD — never dump. This module is the SINGLE SOURCE OF TRUTH for both the
// floor price and the gate decision, shared by the money path (retryPartialFill / handleSell) and by the
// money-path eval harness, so the two can never drift. It is deterministic and side-effect-free: no exchange,
// no network, no clock, no logging — the caller does all I/O.
//
// Design principles:
//   - A (graceful close respects the floor; only panic_sell ignores it): this module NEVER returns allow:true
//     below the floor. There is deliberately no parameter that can disable the floor once a floor is in effect.
//   - B (fail safe, not fail dump): when the bid or floor is unknown/untrustworthy, the decision is HOLD, not
//     sell. A missing price can never be read as "ok to dump".
//   - G (exchange-agnostic): the gate works off a plain best-bid number and a plain floor number, whatever
//     CCXT exchange produced them. No per-exchange branching lives here.


// A usable positive, finite number (a price or quantity we can trust). Zero, negatives, NaN, Infinity,
// null, undefined and non-numeric strings are all rejected — the caller must treat "not usable" as its own
// case (hold), never as a value to compare.
function isPosFinite(v) {

	const n = Number(v);

	return (typeof v !== 'boolean' && isFinite(n) && n > 0);
}


// The lowest price at which a graceful close may fill. SINGLE SOURCE OF TRUTH for the floor.
//
// Default (mode 'breakeven'): break-even net of fees = average * (1 + exchangeFee%). This mirrors the
// break-even that calculateTargetPrice (DCABot.js) builds the take-profit target on top of — the target is
// average*(1 + (takeProfit + fee)%), so the floor is the same expression WITHOUT the take-profit term. The
// floor therefore always sits at/below the target, never above it.
//
// mode 'target_minus_give_back': for operators who would rather still exit a shade into profit — the floor is
// the take-profit target reduced by giveBackPct (e.g. target 0.0205, give-back 20% -> floor 0.0164). Requires
// a usable targetPrice; falls back to break-even if the target is unusable so a config slip can never remove
// the floor entirely.
//
// Returns a positive finite price, or null when it cannot be computed from the inputs (the caller then HOLDS
// rather than guessing — a floor it cannot compute must never become "no floor").
function computeFloorPrice({ average, exchangeFeePercent = 0, mode = 'breakeven', targetPrice = null, giveBackPct = 0 } = {}) {

	const fee = Number(exchangeFeePercent);
	const feePct = (isFinite(fee) && fee > 0) ? fee : 0;   // a missing/0 fee just means break-even == average

	if (mode === 'target_minus_give_back' && isPosFinite(targetPrice)) {

		const gb = Number(giveBackPct);
		const gbPct = (isFinite(gb) && gb > 0) ? Math.min(gb, 100) : 0;   // clamp: a give-back can never exceed 100%
		const floor = Number(targetPrice) * (1 - (gbPct / 100));

		// A give-back of 100% would price the floor at zero (no protection); fall back to break-even in that case.
		if (isPosFinite(floor)) { return floor; }
	}

	if (!isPosFinite(average)) { return null; }

	const breakeven = Number(average) * (1 + (feePct / 100));

	return (isPosFinite(breakeven) ? breakeven : null);
}


// The gate decision for one (re)sell attempt. Pure and deterministic.
//
//   allow:true  — the best bid is at/above the floor: it is safe to place this sell at market.
//   allow:false — HOLD. Either the bid is below the floor (the real loss-prevention), or the bid/floor is
//                 not a usable number (fail safe — never sell on an untrusted price).
//
// `reason` is a short, stable machine code the caller can log / alert / branch on; it is NOT a sentence.
// This function is ONLY about the price floor. Dust (remainder below the exchange minimum) and the retry /
// threshold limits stay with the caller (retryPartialFill already owns the exchange-minimum check), so the
// gate has exactly one job and cannot interact with those limits in a surprising way.
function evaluateSellFloor({ bid, floorPrice } = {}) {

	if (!isPosFinite(floorPrice)) {

		// A floor was requested but could not be established -> cannot protect -> HOLD (principle B).
		return { allow: false, reason: 'floor_unknown' };
	}

	if (!isPosFinite(bid)) {

		// No trustworthy best bid (exchange returned nothing usable) -> HOLD rather than guess (principle B).
		return { allow: false, reason: 'bid_unknown' };
	}

	if (Number(bid) < Number(floorPrice)) {

		// The market has fallen below break-even since the trigger -> HOLD, do not dump (principle A, the fix).
		return { allow: false, reason: 'below_floor' };
	}

	return { allow: true, reason: 'at_or_above_floor' };
}


// SINGLE SOURCE OF TRUTH for how a HELD deal resumes selling its remainder (#130). Given the deal's persisted
// `partialSell` record, decide the safe resume quantity and the prior fills to seed so the eventual close
// reports a true VWAP over the whole position.
//
// SAFE-BY-CONSTRUCTION: it returns a sell quantity of ONLY the persisted remainder (never a re-derived full
// position), and ONLY when that remainder is a sane positive number no larger than what the attempt that held
// was trying to sell. If the persisted state is unreadable it returns `{ active:true, invalid:true }` — never a
// quantity — so the caller HOLDS instead of selling. This is what makes an oversell impossible: there is no
// code path from a bad record to a full-position sell.
//
// Returns one of:
//   { active:false }                                   — not a resume (no held state); caller sells normally.
//   { active:true, invalid:true }                      — held state is unusable; caller must HOLD, never sell.
//   { active:true, invalid:false, sellQty, fills,      — resume: sell ONLY sellQty; seed fills/proceeds/orderIds
//     proceeds, orderIds }                               so the final close credits the whole position.
function resolveResumeSell(partialSell) {

	if (!partialSell || partialSell.active !== true) { return { active: false }; }

	const rem = Number(partialSell.remainingQty);
	const req = Number(partialSell.requestedQty);

	// The remainder must be positive, finite, and no larger than the quantity the held attempt targeted. Anything
	// else (NaN, <=0, or larger than the request) means the record cannot be trusted — HOLD, never re-derive.
	if (!(isPosFinite(rem) && isPosFinite(req) && rem <= (req + 1e-9))) {

		return { active: true, invalid: true };
	}

	// Normalize the seeded prior fills into the fillTracker shape; drop any unusable entry defensively.
	const fills = [];
	let proceeds = 0;

	if (Array.isArray(partialSell.fills)) {

		for (let i = 0; i < partialSell.fills.length; i++) {

			const f = partialSell.fills[i] || {};
			const q = Number(f.qty);

			if (isPosFinite(q)) {

				const v = isPosFinite(Number(f.value)) ? Number(f.value) : ((Number(f.price) || 0) * q);

				fills.push({ qty: q, price: (v > 0 ? v / q : (Number(f.price) || 0)), value: v, value_source: f.value_source || 'average' });
				proceeds += v;
			}
		}
	}

	const orderIds = Array.isArray(partialSell.orderIds) ? partialSell.orderIds.filter(function (x) { return !!x; }) : [];

	return { active: true, invalid: false, sellQty: rem, fills: fills, proceeds: proceeds, orderIds: orderIds };
}


module.exports = {

	computeFloorPrice,
	evaluateSellFloor,
	resolveResumeSell,
	isPosFinite
};
