'use strict';

// Pure tests for sellFloor.computeFloorPrice / evaluateSellFloor — the slippage-safe graceful close.
// No exchange, no network: plain numbers in, a floor price or a gate verdict out. Covers BOTH
// directions (floor passes when the bid is at/above it; floor BLOCKS/HOLDS when the bid is below it or a price
// is untrusted), the break-even and give-back floor modes, and the fail-safe "unknown price → hold" rule that
// guarantees the gate can never dump on a price it cannot trust.

const assert = require('assert');
const { computeFloorPrice, evaluateSellFloor, resolveResumeSell, isPosFinite } = require('../../../strategies/DCABot/sellFloor.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function near(a, b, tol, m) { assert.ok(Math.abs(Number(a) - Number(b)) <= (tol || 1e-9), m + ' (got ' + a + ', want ~' + b + ')'); passed++; }

// ── computeFloorPrice: break-even net of fees (the default) ──
// Mirrors calculateTargetPrice's break-even: average * (1 + fee%). 0.02 avg, 0.5% fee -> 0.0201.
near(computeFloorPrice({ average: 0.02, exchangeFeePercent: 0.5 }), 0.0201, 1e-12, 'break-even floor = average*(1+fee%)');
near(computeFloorPrice({ average: 100, exchangeFeePercent: 0 }), 100, 1e-12, 'zero fee -> floor == average');
near(computeFloorPrice({ average: 0.008520, exchangeFeePercent: 0.4 }), 0.008520 * 1.004, 1e-12, 'ROBO-shape break-even floor');

// The floor must sit at/below the take-profit target, never above it (target adds TP on top of the same base).
{
	const avg = 0.02, fee = 0.4, tp = 1.5;
	const floor = computeFloorPrice({ average: avg, exchangeFeePercent: fee });
	const target = avg * (1 + (tp + fee) / 100);
	ok(floor < target, 'break-even floor is strictly below the take-profit target');
}

// ── computeFloorPrice: target-minus-give-back mode ──
near(computeFloorPrice({ mode: 'target_minus_give_back', targetPrice: 0.0205, giveBackPct: 20 }), 0.0164, 1e-12, 'give-back 20% off target');
near(computeFloorPrice({ mode: 'target_minus_give_back', targetPrice: 0.0205, giveBackPct: 0 }), 0.0205, 1e-12, 'give-back 0% -> floor == target');
// A give-back >= 100% would zero the floor; must fall back to break-even so protection is never removed.
near(computeFloorPrice({ mode: 'target_minus_give_back', targetPrice: 0.0205, giveBackPct: 150, average: 0.02, exchangeFeePercent: 0.5 }), 0.0201, 1e-12, 'give-back clamped; falls back to break-even when it would zero the floor');
// Give-back mode with an unusable target falls back to break-even rather than losing the floor.
near(computeFloorPrice({ mode: 'target_minus_give_back', targetPrice: 0, average: 0.02, exchangeFeePercent: 0.5 }), 0.0201, 1e-12, 'give-back mode with bad target -> break-even fallback');

// ── computeFloorPrice: cannot compute -> null (caller then HOLDS, never "no floor") ──
ok(computeFloorPrice({ average: 0 }) === null, 'zero average -> null');
ok(computeFloorPrice({ average: -1 }) === null, 'negative average -> null');
ok(computeFloorPrice({ average: NaN }) === null, 'NaN average -> null');
ok(computeFloorPrice({}) === null, 'no inputs -> null');

// ── evaluateSellFloor: the gate, BOTH directions ──
// PASS: bid at/above floor -> allow the sell.
ok(evaluateSellFloor({ bid: 0.0085, floorPrice: 0.00848 }).allow === true, 'bid above floor -> allow');
ok(evaluateSellFloor({ bid: 0.00848, floorPrice: 0.00848 }).allow === true, 'bid exactly at floor -> allow (>=)');

// BLOCK: bid below floor -> HOLD. These are the two incident shapes (ROBO 0.008456 < ~0.008554; KAIO below target).
{
	const r = evaluateSellFloor({ bid: 0.008456, floorPrice: 0.008554 });
	ok(r.allow === false && r.reason === 'below_floor', 'ROBO shape: bid below break-even floor -> HOLD (below_floor)');
}
{
	const r = evaluateSellFloor({ bid: 0.019912, floorPrice: 0.0205 });
	ok(r.allow === false && r.reason === 'below_floor', 'KAIO shape: bid below floor -> HOLD (below_floor)');
}

// FAIL SAFE: an untrusted bid or floor is HOLD, never a sell.
ok(evaluateSellFloor({ bid: 0, floorPrice: 0.01 }).allow === false, 'zero bid -> HOLD');
ok(evaluateSellFloor({ bid: NaN, floorPrice: 0.01 }).reason === 'bid_unknown', 'NaN bid -> HOLD (bid_unknown)');
ok(evaluateSellFloor({ bid: undefined, floorPrice: 0.01 }).allow === false, 'missing bid -> HOLD');
ok(evaluateSellFloor({ bid: 0.01, floorPrice: null }).reason === 'floor_unknown', 'no floor established -> HOLD (floor_unknown)');
ok(evaluateSellFloor({ bid: 0.01, floorPrice: 0 }).allow === false, 'zero floor -> HOLD (cannot protect)');
ok(evaluateSellFloor({}).allow === false, 'empty args -> HOLD');

// ── resolveResumeSell: the safe-by-construction resume (can NEVER oversell) ──
// Not a resume: no held state -> caller sells normally.
ok(resolveResumeSell(null).active === false, 'no partialSell -> not a resume');
ok(resolveResumeSell({ active: false, remainingQty: 100, requestedQty: 100 }).active === false, 'inactive partialSell -> not a resume');

// Valid resume: sells ONLY the persisted remainder, seeds prior fills + proceeds + order ids.
{
	const r = resolveResumeSell({
		active: true, requestedQty: 143941, remainingQty: 83748,
		fills: [ { qty: 60193, value: 60193 * 0.008560, value_source: 'average' } ],
		orderIds: ['ordA']
	});
	ok(r.active === true && r.invalid === false, 'valid held state -> resume');
	near(r.sellQty, 83748, 1e-9, 'resume sells ONLY the persisted remainder');
	ok(r.fills.length === 1 && r.orderIds.length === 1, 'prior fills + order ids are seeded');
	near(r.proceeds, 60193 * 0.008560, 1e-6, 'seeded proceeds carried for the closing VWAP');
}

// INVALID resume states -> invalid:true (HOLD), NEVER a sellQty. This is the oversell guard.
ok(resolveResumeSell({ active: true, remainingQty: 0, requestedQty: 100 }).invalid === true, 'zero remainder -> invalid (hold)');
ok(resolveResumeSell({ active: true, remainingQty: -5, requestedQty: 100 }).invalid === true, 'negative remainder -> invalid (hold)');
ok(resolveResumeSell({ active: true, remainingQty: NaN, requestedQty: 100 }).invalid === true, 'NaN remainder -> invalid (hold)');
ok(resolveResumeSell({ active: true, remainingQty: 150, requestedQty: 100 }).invalid === true, 'remainder larger than request -> invalid (hold, never oversell)');
ok(resolveResumeSell({ active: true, remainingQty: 50 }).invalid === true, 'missing requestedQty -> invalid (hold)');
{
	const r = resolveResumeSell({ active: true, remainingQty: 50, requestedQty: 50 });
	ok(r.invalid === false && r.sellQty === 50 && r.fills.length === 0 && r.proceeds === 0, 'valid remainder with no prior fills -> resume with empty seed');
}

// isPosFinite guard rejects the tricky cases (booleans, Infinity, strings).
ok(isPosFinite(1) === true && isPosFinite(0) === false && isPosFinite(-1) === false, 'isPosFinite basics');
ok(isPosFinite(Infinity) === false && isPosFinite(true) === false && isPosFinite('5') === true, 'isPosFinite rejects Infinity/boolean, coerces numeric string');

console.log('SellFloor: ' + passed + ' assertions passed');
process.exit(0);
