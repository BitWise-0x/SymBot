'use strict';

// drivers.js — one driver per scenario `kind`. Each driver invokes the REAL, already-shipped money-path
// function (never a reimplementation), driving it over the scenario's scripted sequence, and returns a plain
// `outcome` object that grade.js then checks. This is what keeps the harness drift-free: a decision is graded
// by running the single function that decision actually lives in, in production.

const DCABot = require('../../strategies/DCABot/DCABot.js');
const PairStatus = require('../../strategies/DCABot/pairStatus.js');
const PriceGuard = require('../../strategies/DCABot/priceGuard.js');
const StopLoss = require('../../strategies/DCABot/stopLoss.js');
const AddFundsMath = require('../../app/AddFundsMath.js');
const Common = require('../../app/Common.js');
const Watchdog = require('../../app/Watchdog.js');
const { makeSimulatedExchange, fillStats } = require('./SimulatedExchange.js');

// ── partial_sell / partial_buy ──────────────────────────────────────────────
// Drives the REAL retryPartialFill remainder loop with an injected `io` (scripted ticker + exchange minimum)
// and a scripted placeOrder (one fill per attempt). Reproduces the ROBO/KAIO "remainder re-sold into a
// walked-down book" shape with synthetic names. The outcome exposes both the #57 crediting guarantee and the
// derived #130 signal (did any chunk fill below break-even) so a scenario can gate the first and FLAG the second.
async function driveRetryPartialFill(scn) {

	const inp = scn.input || {};
	const side = inp.side || 'sell';
	const retries = Array.isArray(inp.retries) ? inp.retries : [];

	// The initial (pre-retry) fill, so VWAP/proceeds and the below-break-even signal cover the whole close.
	const fills = [];
	if (Number(inp.initialFilledQty) > 0) {
		fills.push({ qty: Number(inp.initialFilledQty), price: Number(inp.initialPrice != null ? inp.initialPrice : inp.fallbackPrice) || 0 });
	}

	let attempt = 0;
	const placed = [];

	// Optional realistic fill model: route each retry's order through the SimulatedExchange (signed slippage +
	// commission + depth) and record it in the blotter. Otherwise the literal `retries[n].fill` is used.
	const useModel = !!inp.fillModel;
	const pair = scn.pair || 'ZORVX/USDT';
	const sim = useModel ? makeSimulatedExchange({ fill: inp.fillModel }) : null;

	// Fresh price per retry comes from the ticker (a SELL hits the bid, a BUY lifts the ask) — the scripted
	// `retries[n].bid/ask` is how a walking-down book is modeled.
	const io = {
		getSymbol: async () => {
			const r = retries[Math.min(attempt, retries.length - 1)] || {};
			return { data: { ask: (r.ask != null ? r.ask : inp.fallbackPrice), bid: (r.bid != null ? r.bid : inp.fallbackPrice) } };
		},
		filterPrice: async (_e, _p, price) => price,
		filterAmount: async (_e, _p, qty) => (Number(qty) < Number(inp.minAmount || 0) ? 0 : Number(qty)),
		orderFilledQty: (o) => Number(o && o.filled) || 0,
		delay: async () => {},
		log: () => {}
	};

	const placeOrder = async ({ qty, price }) => {
		if (useModel) {
			const order = sim.createOrder({ symbol: pair, side: side, amount: Number(qty), price: Number(price) });
			attempt++;
			placed.push({ qty: Number(qty), price: Number(price), filled: order.filled });
			return { filled: order.filled, data: { id: order.id }, data_order: { price: Number(price), average: (order.average != null ? order.average : Number(price)), quantity: order.filled }, message: order.status };
		}
		const r = retries[Math.min(attempt, retries.length - 1)] || {};
		const filled = Number(r.fill != null ? r.fill : 0);
		attempt++;
		placed.push({ qty: Number(qty), price: Number(price), filled });
		return { filled, data: { id: 'ord' + attempt }, data_order: { price, average: price, quantity: filled }, message: r.message || 'ok' };
	};

	// Record the ACTUAL average fill price (slippage-adjusted when modeled) so VWAP reflects what really filled.
	const onFill = async (filledQty, orderResult, priceFiltered) => {
		const px = (orderResult && orderResult.data_order && orderResult.data_order.average != null) ? Number(orderResult.data_order.average) : Number(priceFiltered);
		fills.push({ qty: Number(filledQty), price: px });
	};

	let aborted = false;
	const abortAfter = (inp.abortAfter == null) ? Infinity : Number(inp.abortAfter);
	const isAborted = () => { const a = aborted; if (attempt >= abortAfter) { aborted = true; } return a; };

	const res = await DCABot.retryPartialFill({
		side,
		exchange: null, pair: scn.pair || 'ZORVX/USDT', dealId: scn.name || 'eval',
		requestedQty: Number(inp.requestedQty),
		initialFilledQty: Number(inp.initialFilledQty) || 0,
		fallbackPrice: Number(inp.fallbackPrice) || 0,
		placeOrder, onFill, isAborted,
		threshold: (inp.threshold != null ? inp.threshold : undefined),
		maxRetries: (inp.maxRetries != null ? inp.maxRetries : undefined),
		// Slippage-safe floor gate (#130). A scenario supplies floorPrice to exercise the hold; omit it to prove
		// the loop is byte-identical to the legacy behavior (floor disabled).
		floorPrice: (inp.floorPrice != null ? Number(inp.floorPrice) : null),
		io
	});

	const agg = fillStats(fills);
	const breakeven = (inp.breakeven != null) ? Number(inp.breakeven) : null;
	const minFillPrice = fills.length ? Math.min(...fills.map((f) => f.price)) : 0;

	const out = {
		totalFilled: res.totalFilled,
		qtyRemaining: res.qtyRemaining,
		retryCount: res.retryCount,
		fillCount: fills.length,
		vwap: agg.vwap,
		proceeds: agg.proceeds,
		minFillPrice: minFillPrice,
		// Derived #130 signal: did any chunk realize below break-even? With the floor gate active this becomes a
		// HARD gate (must stay false); without a floor it stays a soft flag over the legacy behavior.
		soldBelowBreakeven: (breakeven != null) ? (minFillPrice > 0 && minFillPrice < breakeven) : false,
		// The #130 floor-gate outcome: held=true means the loop stopped WITHOUT dumping the remainder below the
		// floor. qtyRemaining is then the quantity the deal holds for a later auto-resume.
		held: !!res.held,
		holdReason: res.holdReason || null,
		placedCount: placed.length,
		// The PRECISE #130 hard gate: did any PLACED REMAINDER re-sell fill below the floor? The initial market
		// fill already happened and is excluded (the gate cannot un-sell it); this is strictly the re-sell the
		// floor gate must prevent. With the gate active it is always false — the loop holds instead.
		remainderSoldBelowFloor: (inp.floorPrice != null)
			? placed.some((p) => Number(p.filled) > 0 && Number(p.price) < Number(inp.floorPrice))
			: false
	};

	// When driven through the SimulatedExchange fill model, expose the realized blotter stats (VWAP net of
	// signed slippage, total commission) so a scenario can grade what actually filled.
	if (useModel) {
		const b = fillStats(sim.blotter());
		out.blotterVwap = b.vwap;
		out.blotterFee = b.fee;
		out.blotterFilled = b.filled;
	}

	return out;
}

// ── target ──────────────────────────────────────────────────────────────────
async function driveTargetPrice(scn) {
	const inp = scn.input || {};
	const exchange = makeSimulatedExchange(scn.exchange || {});
	const pair = scn.pair || 'ZORVX/USDT';
	const target = await DCABot.calculateTargetPrice({
		exchange, pair,
		price: Number(inp.price),
		takeProfit: Number(inp.takeProfit),
		exchangeFee: Number(inp.exchangeFee)
	});
	return { target: Number(target) };
}

// ── tradable (delisting / suspended / limit-only pre-start gate + watchdog decision) ──
function driveTradable(scn) {
	const pair = scn.pair || 'ZORVX/USDT';
	const exCfg = scn.exchange || {};
	// A scenario with no market entry for the pair models a delisted / removed pair (market lookup → null).
	const market = (exCfg.markets && exCfg.markets[pair]) ? makeSimulatedExchange(exCfg).market(pair) : null;
	const v = PairStatus.evaluatePairTradable(market, pair);
	return { tradable: v.tradable, limitOnly: v.limitOnly, status: v.status, reason: v.reason };
}

// ── clock skew ────────────────────────────────────────────────────────────────
function driveClockSkew(scn) {
	const inp = scn.input || {};
	const v = Watchdog.evaluateClockSkew(Number(inp.skewMs), (inp.warnMs != null ? Number(inp.warnMs) : undefined));
	return { flagged: !!v, ahead: v ? v.ahead : null, severe: v ? v.severe : null, detail: v ? v.detail : '' };
}

// ── price sanity (implausible-price close hold) ──────────────────────────────
function drivePriceSanity(scn) {
	const inp = scn.input || {};
	const v = PriceGuard.evaluatePriceSanity({
		price: inp.price, reference: inp.reference,
		maxHighRatio: inp.maxHighRatio, maxLowRatio: inp.maxLowRatio
	}) || {};
	// Normalize to a stable, gradable shape regardless of the helper's internal field names.
	return { plausible: (v.ok === true || v.plausible === true || v.sane === true), raw: v };
}

// ── shortfall math ────────────────────────────────────────────────────────────
function driveShortfall(scn) {
	const inp = scn.input || {};
	return { percent: DCABot.partialFillShortfallPercent(Number(inp.filled), Number(inp.requested)) };
}

// ── order_fill (the SimulatedExchange fill model + blotter) ──────────────────
// Drives a SEQUENCE of createOrder calls against ONE SimulatedExchange and grades the realized fills and the
// blotter. Exercises signed slippage (buy fills above / sell fills below the reference), separate commission,
// depth-capped partials, and — when `exchange.fill.book` is set — a DEPLETING order-book walk (each order
// consumes liquidity so the next faces a thinner, worse book, the realistic ROBO/KAIO cascade).
function driveOrderFill(scn) {
	const inp = scn.input || {};
	const pair = scn.pair || 'ZORVX/USDT';
	const sim = makeSimulatedExchange(scn.exchange || {});
	const orders = Array.isArray(inp.orders) ? inp.orders : [];

	const results = [];
	for (const o of orders) {
		results.push(sim.createOrder({ symbol: pair, side: (o.side || inp.side || 'sell'), amount: Number(o.amount), price: Number(o.price) }));
	}

	const blotter = sim.blotter();
	const stats = fillStats(blotter);
	const first = results[0] || {};
	const last = results[results.length - 1] || {};

	return {
		orderCount: results.length,
		blotterLen: blotter.length,
		totalFilled: stats.filled,
		vwap: stats.vwap,
		totalFee: stats.fee,
		firstAvg: (first.average == null ? null : Number(first.average)),
		firstFilled: (first.filled == null ? null : Number(first.filled)),
		firstStatus: first.status,
		lastAvg: (last.average == null ? null : Number(last.average)),
		lastFilled: (last.filled == null ? null : Number(last.filled))
	};
}

// ── stop_loss / trailing_tp (the REAL pure stopLoss.evaluate decision) ───────
// scn.input is the exact data object stopLoss.evaluate takes (enabled, price, average, stopLossPercent,
// feeRate, reference, moveBreakeven, breakevenArmed, breakevenTrigger, profitPercentage, and the trailing
// inputs trailingEnabled / trailingDistance / trailingActivateProfit / trailHighPrice). SymBot's trailing
// take-profit IS the trailing stop that replaces the fixed TP, so `trailing_tp` grades the SAME function — no
// separate trailing model, no drift. The outcome exposes both the hard-stop and trailing fields.
function driveStopLoss(scn) {
	const r = StopLoss.evaluate(scn.input || {}) || {};
	return {
		triggered: !!r.triggered,
		reason: r.reason,
		breakevenArmed: !!r.breakevenArmed,
		breakevenLevel: (r.breakevenLevel == null ? null : Number(r.breakevenLevel)),
		trailingActive: !!r.trailingActive,
		trailLevel: (r.trailLevel == null ? null : Number(r.trailLevel)),
		level: (r.level == null ? null : Number(r.level))
	};
}

// ── add_funds (the REAL AddFundsMath.computeAddFundsForward ladder/break-even math) ──
// scn.input is the exact params object the real add-funds projection takes (sum, qtySum, addAmount,
// exchangeFee, targetProfitPercent, addPrice/price, and the optional projected-profit inputs). The flat result
// object is returned as-is so scenarios grade its real fields (average_price_net, target_price_net,
// break_even_net, average_price_change_percent, valid, …).
function driveAddFunds(scn) {
	return AddFundsMath.computeAddFundsForward(scn.input || {}) || {};
}

// ── circuit_breaker (the REAL deal-start enforcement gate canStartDeal) ──────
// Drives the money-path gate every deal-start path funnels through. An active breaker must refuse BEFORE any
// pair/DB work. canStartDeal only READS shareData.appData.circuit_breaker_active, so we init DCABot ONCE with a
// minimal stub shareData (a no-op start-queue and a no-op startSignals so the one-time async initApp completes
// cleanly without a real queue or any network), capture the appData, and then just mutate the breaker flag per
// scenario. pairBlackListed (the one collaborator the CLEARED path reaches) is saved/restored around each run,
// so nothing leaks into other scenarios.
let _breakerAppData = null;
function ensureBreakerInit() {
	if (_breakerAppData) { return _breakerAppData; }
	const appData = {};
	const origStartSignals = Common.startSignals;
	Common.startSignals = async () => {};   // keep the one-time init off the network
	try {
		DCABot.init({ appData: appData, Queue: { create: async () => ({ add: async (fn) => (typeof fn === 'function' ? fn() : undefined), size: () => 0 }) } });
	}
	finally {
		Common.startSignals = origStartSignals;
	}
	_breakerAppData = appData;
	return appData;
}

async function driveCircuitBreaker(scn) {
	const inp = scn.input || {};

	const appData = ensureBreakerInit();
	appData.circuit_breaker_active = (inp.breakerReason != null) ? inp.breakerReason : (inp.active ? 'Circuit breaker tripped (eval)' : null);

	const origBlacklist = Common.pairBlackListed;
	Common.pairBlackListed = async () => !!inp.blacklisted;

	try {
		const res = await DCABot.canStartDeal({ pair: scn.pair || 'ZORVX/USDT', config: inp.config || {} });
		return { allowed: !!res.allowed, reason: res.reason || '' };
	}
	finally {
		Common.pairBlackListed = origBlacklist;
	}
}

const drivers = {
	partial_sell: driveRetryPartialFill,
	partial_buy: driveRetryPartialFill,
	target: driveTargetPrice,
	tradable: driveTradable,
	clock: driveClockSkew,
	price_sanity: drivePriceSanity,
	shortfall: driveShortfall,
	stop_loss: driveStopLoss,
	trailing_tp: driveStopLoss,
	add_funds: driveAddFunds,
	circuit_breaker: driveCircuitBreaker,
	order_fill: driveOrderFill
};

async function runDriver(scn) {
	const fn = drivers[scn.kind];
	if (typeof fn !== 'function') { throw new Error('unknown scenario kind: ' + scn.kind); }
	return await fn(scn);
}

module.exports = { drivers, runDriver };
