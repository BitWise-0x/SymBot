'use strict';

// SimulatedExchange — a small, deterministic, CCXT-shaped exchange simulator for the money-path replay eval
// harness.
//
// It is the SINGLE SOURCE OF TRUTH for simulated exchange behavior in the harness: markets (with `active`,
// `info`, precision), a server clock, a ticker, an order book, and the precision helpers the real DCA order
// code calls (`priceToPrecision` / `amountToPrecision`). Every scenario configures one of these from plain
// data, so the real money-path functions run UNCHANGED against it — no network, no account, no real orders.
//
// It is deliberately generic and extensible: the backtesting engine (a separate, larger feature) can reuse
// and extend this same primitive (e.g. add fetchOHLCV) so the two never drift into two different simulators.
//
// Pure and side-effect-free: identical config in → identical behavior out. Never throws from a getter; a
// missing market throws from market()/priceToPrecision the way CCXT does, so "unknown pair" is exercised too.

function decimalsOf(precisionValue, fallback) {
	const n = Number(precisionValue);
	if (Number.isInteger(n) && n >= 0 && n <= 18) { return n; }
	return (fallback == null) ? 8 : fallback;
}

// Round a number to a fixed number of decimal places and return it as a string, as CCXT's *ToPrecision do.
function toFixedStr(value, decimals) {
	const n = Number(value);
	if (!isFinite(n)) { return String(value); }
	return n.toFixed(decimals);
}

// cfg:
//   {
//     name, precisionMode,                       // precisionMode defaults to 2 (DECIMAL_PLACES)
//     serverTimeMs,                              // for fetchTime()
//     markets: { 'ZORVX/USDT': { active, info, precision:{price,amount}, limits } },
//     ticker:  { ask, bid, last } | { 'ZORVX/USDT': {ask,bid,last} },
//     orderBook: { bids:[[p,q]], asks:[[p,q]] } | { 'PAIR': {...} }
//   }
function makeSimulatedExchange(cfg) {

	cfg = cfg || {};

	const markets = {};
	const rawMarkets = cfg.markets || {};

	for (const sym of Object.keys(rawMarkets)) {

		const m = rawMarkets[sym] || {};
		const precision = m.precision || {};

		markets[sym] = {
			symbol: sym,
			active: (m.active === undefined) ? true : !!m.active,
			info: m.info || {},
			precision: { price: (precision.price == null ? 8 : precision.price), amount: (precision.amount == null ? 8 : precision.amount) },
			limits: m.limits || { amount: {}, cost: {} }
		};
	}

	function perPair(obj, pair) {
		if (!obj) { return null; }
		// Either a flat object (one shape for all pairs) or keyed by pair.
		if (pair && Object.prototype.hasOwnProperty.call(obj, pair)) { return obj[pair]; }
		if (obj.ask !== undefined || obj.bid !== undefined || obj.last !== undefined || obj.bids !== undefined || obj.asks !== undefined) { return obj; }
		return null;
	}

	// ── Fill model + blotter ─────────────────────────────────────────────────────
	// cfg.fill: { slippageBps, commissionRate, depth, book }
	//   slippageBps    — SIGNED adverse slippage in basis points: a BUY fills ABOVE the reference price, a SELL
	//                    fills BELOW it (0 = exactly at the reference). Used by the FLAT model.
	//   commissionRate — taker fee as a fraction of filled notional (0.001 = 0.1%), modeled SEPARATELY from
	//                    slippage because they scale differently with trade size.
	//   depth          — FLAT model: how much can fill — a number (same cap every order), an array (the i-th
	//                    order fills up to depth[i], a thinning book; beyond the array it is exhausted → 0), or
	//                    undefined (full fill).
	//   book           — BOOK-WALK model (more accurate; follows standard "walk the book" market-impact
	//                    practice): { bids:[[price,qty],…], asks:[[price,qty],…] }. An order consumes resting
	//                    liquidity on its side best-price-first, so the fill price is the VWAP of the levels it
	//                    ate (signed slippage and partial fills emerge from ONE mechanism), and the levels are
	//                    DEPLETED — the next order faces a thinner, worse book (the realistic cascade). When a
	//                    book is configured for a side, it overrides the flat model for that side.
	// Every order is recorded in the blotter for grading and inspection. A future extension can price sizes past
	// the visible book with a square-root market-impact term; the walk-the-book model is the honest baseline.
	const fillCfg = cfg.fill || {};
	const slippageBps = Number(fillCfg.slippageBps) || 0;
	const commissionRate = Number(fillCfg.commissionRate) || 0;
	const blotter = [];
	let orderN = 0;

	// Mutable copy of the resting book (best-first) so consuming liquidity thins it for later orders.
	const book = {
		bids: (fillCfg.book && Array.isArray(fillCfg.book.bids)) ? fillCfg.book.bids.map((l) => [Number(l[0]), Number(l[1])]).sort((a, b) => b[0] - a[0]) : null,
		asks: (fillCfg.book && Array.isArray(fillCfg.book.asks)) ? fillCfg.book.asks.map((l) => [Number(l[0]), Number(l[1])]).sort((a, b) => a[0] - b[0]) : null
	};

	function depthFor(idx, requested) {
		const d = fillCfg.depth;
		if (d == null) { return requested; }
		if (Array.isArray(d)) { return Number(idx < d.length ? d[idx] : 0); }   // beyond the scripted book → exhausted
		return Number(d);
	}

	// Consume up to `amount` from the resting book on `side`, best-price-first, DEPLETING the levels. Returns
	// { filled, avgPrice } or null when no book is configured for that side (caller falls back to the flat model).
	function walkBook(side, amount) {
		const levels = (String(side).toLowerCase() === 'buy') ? book.asks : book.bids;
		if (!levels) { return null; }
		let remaining = Math.max(0, Number(amount) || 0), filled = 0, notional = 0;
		for (const lvl of levels) {
			if (remaining <= 0) { break; }
			const take = Math.min(remaining, Math.max(0, lvl[1]));
			if (take <= 0) { continue; }
			filled += take; notional += take * lvl[0]; lvl[1] -= take; remaining -= take;
		}
		return { filled: filled, avgPrice: filled > 0 ? notional / filled : NaN };
	}

	// CCXT-shaped createOrder. Accepts the positional form (symbol, type, side, amount, price) or an object
	// ({ symbol, side, amount, price, type }). Deterministic; never throws on a bad amount (floors at 0).
	function createOrder(symbol, type, side, amount, price) {
		if (symbol && typeof symbol === 'object') {
			const o = symbol; type = o.type || 'market'; side = o.side; amount = o.amount; price = o.price; symbol = o.symbol;
		}
		const ref = Number(price);
		const amt = Math.max(0, Number(amount) || 0);
		const sign = (String(side).toLowerCase() === 'buy') ? 1 : -1;

		let avg, filled;
		const walked = walkBook(side, amt);
		if (walked) {
			// Book-walk model: price and partial come from the depth actually consumed.
			filled = walked.filled;
			avg = isFinite(walked.avgPrice) ? walked.avgPrice : ref;
		}
		else {
			// Flat model: signed slippage off the reference, depth-capped partial.
			avg = isFinite(ref) ? (ref * (1 + sign * (slippageBps / 10000))) : ref;
			filled = Math.min(amt, Math.max(0, depthFor(orderN, amt)));
		}

		const fee = filled * (isFinite(avg) ? avg : 0) * commissionRate;
		const status = (amt > 0 && filled >= amt) ? 'closed' : 'canceled';   // partial → remainder canceled (IOC-collar shape)
		orderN++;
		const entry = { n: orderN, symbol: symbol, side: side, requested: amt, filled: filled, refPrice: ref, avgPrice: avg, fee: fee, status: status };
		blotter.push(entry);
		return { id: 'sim' + orderN, symbol: symbol, type: type || 'market', side: side, amount: amt, filled: filled, average: (filled > 0 ? avg : undefined), status: status, fee: { cost: fee, currency: 'quote' }, info: entry };
	}

	const exchange = {

		precisionMode: (cfg.precisionMode == null) ? 2 : cfg.precisionMode,

		has: { fetchTime: cfg.serverTimeMs != null, fetchOrderBook: !!cfg.orderBook, fetchTicker: !!cfg.ticker, createOrder: true, createMarketOrder: true, createLimitOrder: true },

		markets: markets,

		createOrder: createOrder,
		createMarketOrder: (symbol, side, amount, price) => createOrder(symbol, 'market', side, amount, price),
		// A copy of every simulated fill, for grading realized VWAP / slippage / fees and for inspection.
		blotter: () => blotter.map((e) => Object.assign({}, e)),

		market(pair) {
			const m = markets[pair];
			if (!m) { const e = new Error('simulatedexchange does not have market symbol ' + pair); e.name = 'BadSymbol'; throw e; }
			return m;
		},

		async loadMarkets() { return markets; },

		async fetchTime() {
			if (cfg.serverTimeMs == null) { const e = new Error('fetchTime not supported'); e.name = 'NotSupported'; throw e; }
			return Number(cfg.serverTimeMs);
		},

		async fetchTicker(pair) {
			const t = perPair(cfg.ticker, pair);
			if (!t) { const e = new Error('no ticker for ' + pair); e.name = 'BadSymbol'; throw e; }
			return { symbol: pair, ask: t.ask, bid: t.bid, last: (t.last == null ? t.bid : t.last) };
		},

		async fetchOrderBook(pair) {
			const b = perPair(cfg.orderBook, pair);
			return b ? { bids: b.bids || [], asks: b.asks || [] } : { bids: [], asks: [] };
		},

		priceToPrecision(pair, price) {
			const m = this.market(pair);
			return toFixedStr(price, decimalsOf(m.precision.price, 8));
		},

		amountToPrecision(pair, amount) {
			const m = this.market(pair);
			return toFixedStr(amount, decimalsOf(m.precision.amount, 8));
		}
	};

	return exchange;
}

// Pure aggregation over fill records — the SINGLE SOURCE OF TRUTH for VWAP / proceeds / fees across the harness.
// Accepts blotter entries ({ filled, avgPrice, fee }) or simple fills ({ qty, price }).
function fillStats(entries) {
	let qty = 0, notional = 0, fee = 0;
	for (const e of (entries || [])) {
		const q = Number(e && (e.filled != null ? e.filled : e.qty)) || 0;
		const p = Number(e && (e.avgPrice != null ? e.avgPrice : e.price)) || 0;
		qty += q; notional += q * p; fee += Number(e && e.fee) || 0;
	}
	return { filled: qty, proceeds: notional, vwap: qty > 0 ? notional / qty : 0, fee: fee };
}

module.exports = { makeSimulatedExchange, fillStats, decimalsOf, toFixedStr };
