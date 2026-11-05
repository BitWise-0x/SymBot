'use strict';

// Pure tests for Watchdog.evaluateSellPartialHold — the held-deal decision behind the sell_partial_hold
// watchdog (#130). A deal whose persisted partialSell.active is true is holding an unsold remainder because the
// market fell below the break-even floor mid-close; the watchdog surfaces a PERSISTENT hold (past a grace
// window) so it is not forgotten. Offline/deterministic: a list of deal-shaped objects + now + grace go in, a
// single finding (or null) comes out. Read-only — it never touches an order. Covers both directions, the grace
// boundary, sort-by-oldest, and the no-false-alarm cases.

const assert = require('assert');
const Watchdog = require('../../app/Watchdog.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const f = Watchdog.evaluateSellPartialHold;
const MIN = 60 * 1000;
const now = 1000000000000;

// ── nothing held → null ──
ok(f([], now, 15 * MIN) === null, 'no deals → null');
ok(f(null, now, 15 * MIN) === null, 'non-array → null');
ok(f([ { dealId: 'd1', pair: 'A/USDT' } ], now, 15 * MIN) === null, 'open deal with no partialSell → null');
ok(f([ { dealId: 'd1', partialSell: { active: false } } ], now, 15 * MIN) === null, 'partialSell.active false → null');

// ── a hold within the grace window is NOT flagged (handleFloorHold already alerted; usually self-resolves) ──
ok(f([ { dealId: 'd1', pair: 'A/USDT', partialSell: { active: true, heldAt: new Date(now - 5 * MIN) } } ], now, 15 * MIN) === null,
	'held 5 min with a 15 min grace → null (too fresh to nag)');

// ── a hold PAST the grace window IS flagged ──
let r = f([ { dealId: 'd1', pair: 'ZORVX/USDT', partialSell: { active: true, heldAt: new Date(now - 40 * MIN) } } ], now, 15 * MIN);
ok(r && r.action === 'watchdog.sell_partial_hold', 'held 40 min past grace → finding');
ok(r && r.target === '1', 'target is the count of held deals');
ok(r && /40 min/.test(r.detail) && /ZORVX\/USDT/.test(r.detail), 'detail names the duration and pair');
ok(r && /panic_sell/.test(r.detail), 'detail points the operator to panic_sell as the force-exit');

// ── grace boundary (>= grace flags; just under does not) ──
ok(f([ { dealId: 'd', pair: 'A/USDT', partialSell: { active: true, heldAt: new Date(now - 15 * MIN) } } ], now, 15 * MIN) !== null, 'exactly at grace → flagged (>=)');
ok(f([ { dealId: 'd', pair: 'A/USDT', partialSell: { active: true, heldAt: new Date(now - (15 * MIN - 1)) } } ], now, 15 * MIN) === null, 'one ms under grace → null');

// ── multiple holds: count all past grace, report the longest first ──
r = f([
	{ dealId: 'd1', pair: 'AAA/USDT', partialSell: { active: true, heldAt: new Date(now - 20 * MIN) } },
	{ dealId: 'd2', pair: 'BBB/USDT', partialSell: { active: true, heldAt: new Date(now - 90 * MIN) } },
	{ dealId: 'd3', pair: 'CCC/USDT', partialSell: { active: true, heldAt: new Date(now - 2 * MIN) } }  // within grace, excluded
], now, 15 * MIN);
ok(r && r.target === '2', 'two of three holds are past grace');
ok(r && /90 min/.test(r.detail) && r.detail.indexOf('BBB/USDT') < r.detail.indexOf('AAA/USDT'), 'longest hold (BBB, 90m) is reported first');
ok(r && r.detail.indexOf('CCC/USDT') === -1, 'the within-grace hold is excluded');

// ── missing heldAt is treated as "held now" (age 0) → within any positive grace → not flagged ──
ok(f([ { dealId: 'd', pair: 'A/USDT', partialSell: { active: true } } ], now, 15 * MIN) === null, 'held with no heldAt → age 0 → within grace → null');
// …but with a zero grace, even a just-registered hold is surfaced.
ok(f([ { dealId: 'd', pair: 'A/USDT', partialSell: { active: true } } ], now, 0) !== null, 'zero grace surfaces every active hold');

// ── default grace (undefined) is 15 min ──
ok(f([ { dealId: 'd', pair: 'A/USDT', partialSell: { active: true, heldAt: new Date(now - 10 * MIN) } } ], now) === null, 'default grace (15m): 10 min hold → null');
ok(f([ { dealId: 'd', pair: 'A/USDT', partialSell: { active: true, heldAt: new Date(now - 20 * MIN) } } ], now) !== null, 'default grace (15m): 20 min hold → finding');

console.log('WatchdogSellPartialHold: ' + passed + ' assertions passed');
process.exit(0);
