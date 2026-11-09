'use strict';

// Locks the system-pause taxonomy that the trading loop and the UI both depend on.
//
// A sell must never be placed while an order is still unresolved. A prior SELL in flight would let a
// panic/stop place a SECOND live order for coin already committed (oversell); a safety-order BUY in
// verification means the coin isn't credited yet, so selling would strand it. The follow loop expresses
// this by refusing the sell branch when the deal's pauseReason marks a sell as in flight
// ('order_verify_sell'), filled-but-not-finalized ('sell_finalize_error'), or a buy in verification
// ('order_verify_buy'). A generic, retryable sell error uses a distinct reason ('sell_error') that does
// NOT block a panic and auto-recovers. A slippage-safe-close hold ('sell_partial_hold', #130) likewise does
// NOT block a panic — it is lifted by price recovery, not by this guard — so panic/stop can always force the
// held remainder out. The UI must show ALL of these reasons as "system" pauses (not manual). This test pins
// both halves so a change to the reason strings can't silently desync the guard, the restart recovery, and the UI.

const assert = require('assert');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// ── The unified pause-reason taxonomy (single source of truth) ──
// libs/app/pauseReasons.js is the ONE definition the backend money path sets reasons from AND the frontend
// displays. The server hands it to the browser via EJS (partialsHeaderView inlines appData.pause_reasons as
// window.SymBot.PAUSE_REASONS); here we simulate that injection, then load the real client helper so it reads
// the SAME data the backend uses. That is what makes the two unable to drift.
const PauseReasons = require('../../../app/pauseReasons.js');

global.window = global.window || {};
global.window.SymBot = global.window.SymBot || {};
global.window.SymBot.PAUSE_REASONS = PauseReasons.REASONS;   // the EJS injection, reproduced for the test

const SymBot = require('../../../webserver/public/js/symbot-ui.js') || global.window.SymBot;
const ui = (SymBot && SymBot.UI) || global.window.SymBot.UI;

// Derive the reason list FROM the source of truth, so this test can never itself go stale when a reason is
// added or removed — it always covers exactly what the module defines.
const SYSTEM_REASONS = PauseReasons.keys();

ok(SYSTEM_REASONS.length > 0, 'the pause-reason taxonomy is non-empty');

// The client helper (reading the injected map) and the module helper must agree for every reason — the same
// source, verified from both entry points.
for (const reason of SYSTEM_REASONS) {
	const uiInfo = ui.systemPauseInfo(reason);
	const modInfo = PauseReasons.systemPauseInfo(reason);
	ok(uiInfo.isSystem === modInfo.isSystem && uiInfo.type === modInfo.type && uiInfo.description === modInfo.description,
		reason + ': frontend systemPauseInfo matches the backend module (one source of truth)');
}

for (const reason of SYSTEM_REASONS) {
	const info = ui.systemPauseInfo(reason);
	ok(info.isSystem === true, reason + ' is a system pause');
	ok(typeof info.type === 'string' && info.type.length > 0, reason + ' has a side label');
	ok(typeof info.description === 'string' && info.description.length > 0, reason + ' has a description');
}

// Order-verify reasons name the correct side.
ok(ui.systemPauseInfo('order_verify_buy').type === 'buy order', 'order_verify_buy => buy order');
ok(ui.systemPauseInfo('buy_error').type === 'buy order', 'buy_error => buy order');
ok(ui.systemPauseInfo('order_verify_sell').type === 'sell order', 'order_verify_sell => sell order');

// A manual pause / unknown / empty reason is NOT a system pause.
for (const reason of ['', null, undefined, 'user', 'manual', 'something_else']) {
	const info = ui.systemPauseInfo(reason);
	ok(info.isSystem === false, JSON.stringify(reason) + ' is not a system pause');
	ok(info.type === '' && info.description === '', JSON.stringify(reason) + ' yields empty fields');
}

// ── Order-in-flight sell guard invariant (characterization of the sell-branch guard) ──
// Mirrors the follow-loop condition: the automated sell branch (take-profit, stop-loss, panic, cancel)
// must be refused while an order is unresolved — either a SELL in flight ('order_verify_sell' /
// 'sell_finalize_error'), where a second sell would oversell committed coin, OR a safety-order BUY in
// background verification ('order_verify_buy'), where selling now would move only the credited qty and
// strand the pending buy's coin (the post-close reconcile filters status:0 and never picks it up).
// Crucially, 'order_verify_buy' is used ONLY for a genuine in-flight, likely-filled order. A buy that
// FAILED with nothing in flight (insufficient funds, exchange-cancelled, generic) uses a distinct
// 'buy_error' reason that does NOT block the sell — there is no pending coin to strand, so the deal must
// still be able to take profit or stop-loss. A generic, retryable sell error ('sell_error') likewise
// has nothing in flight and does NOT block a panic.
function sellBlockedByOrderInFlight(pauseReason) {
	return pauseReason === 'order_verify_sell'
		|| pauseReason === 'sell_finalize_error'
		|| pauseReason === 'order_verify_buy';
}

ok(sellBlockedByOrderInFlight('order_verify_sell') === true, 'in-flight sell verify blocks a sell (no oversell)');
ok(sellBlockedByOrderInFlight('sell_finalize_error') === true, 'filled-but-unfinalized blocks a sell (coin already gone)');
ok(sellBlockedByOrderInFlight('order_verify_buy') === true, 'an in-flight buy verification blocks a sell (pending coin uncredited)');
ok(sellBlockedByOrderInFlight('buy_error') === false, 'a non-in-flight buy failure (NSF / canceled / generic) does NOT block a sell — nothing to strand, so the deal can still exit');
ok(sellBlockedByOrderInFlight('sell_error') === false, 'a generic sell error does NOT block panic (nothing in flight)');
ok(sellBlockedByOrderInFlight('') === false, 'no pause reason does not block a sell');
// A slippage-safe-close hold (#130) is a PRICE-floor hold, not an order-in-flight block: it must NOT sit in the
// order-in-flight exclusion list (so panic_sell / stop-loss can always force the held remainder out), yet it
// still renders as a SYSTEM pause so the UI explains it and warns before a manual resume. This pins that it is
// lifted by price recovery (handled elsewhere), never by this guard.
ok(sellBlockedByOrderInFlight('sell_partial_hold') === false, 'a slippage-safe-close hold does NOT block a sell (panic/stop can force the exit; take-profit auto-resumes on price recovery)');
ok(ui.systemPauseInfo('sell_partial_hold').isSystem === true && ui.systemPauseInfo('sell_partial_hold').type === 'sell order', 'sell_partial_hold still renders as a system (sell-order) pause in the UI');

// Every reason that blocks a sell must also render as a system pause in the UI (they cannot desync).
for (const reason of SYSTEM_REASONS) {
	if (sellBlockedByOrderInFlight(reason)) {
		ok(ui.systemPauseInfo(reason).isSystem === true, reason + ' blocks sells AND shows as a system pause');
	}
}

// ── ANTI-DRIFT WELD: every pause reason the ENGINE can set must be classified by the UI ──────────────────
// The bug this guards against (and that actually shipped once): the backend introduces a new deal pause reason
// (e.g. 'sell_partial_hold') but systemPauseInfo in symbot-ui.js is not updated, so the UI silently fails to
// recognize the pause — no "system paused" tint, no explanation, no resume warning. Rather than rely on a
// hand-maintained list staying in sync, this EXTRACTS the reason literals the engine actually sets from
// DCABot.js and asserts each is a system pause in the UI helper. A new reason added to the money path without a
// matching UI entry now FAILS this test in CI — the two can no longer drift apart. Source-scan, so it stays
// correct as the engine changes; no money-path code is touched.
const fs = require('fs');
const path = require('path');

const dcaSrc = fs.readFileSync(path.join(__dirname, '../../../strategies/DCABot/DCABot.js'), 'utf8');
const VALID = new Set(PauseReasons.keys());

// (a) Every reason the engine sets via the shared constants — PR.<NAME> — must resolve to a taxonomy key. A
// typo (PR.SELL_EROR) or a new constant not added to the module is caught here (NAME not in the taxonomy).
const constUsed = new Set();
let m; const reConst = /\bPR\.([A-Z_]+)\b/g;
while ((m = reConst.exec(dcaSrc))) { constUsed.add(m[1].toLowerCase()); }

// (b) Belt-and-suspenders: any RAW lowercase snake_case literal on a pause-reason line (an assignment, a
// persisted 'pauseReason', a pauseDeal/compare against resumePauseReason) that bypassed the constants. These
// must ALSO be valid taxonomy keys, so a stray string literal can't reintroduce drift. '' is the clear/no-pause
// sentinel and is skipped. camelCase keys like 'pauseReason' are not matched (the pattern requires lowercase).
const literalUsed = new Set();
for (const line of dcaSrc.split('\n')) {
	if (!/isDealPauseReason\s*[=!]==?|'pauseReason'\s*:|resumePauseReason\s*===|\bpauseDeal\s*\(/.test(line)) { continue; }
	const toks = line.match(/'([a-z][a-z_]{2,})'/g) || [];
	for (const t of toks) { const r = t.slice(1, -1); if (r !== 'pausereason') { literalUsed.add(r); } }
}

const engineReasons = new Set([...constUsed, ...literalUsed]);

// A run that extracted nothing means the scan patterns no longer match the source — a FAILURE, not a silent pass.
ok(engineReasons.size > 0, 'extracted at least one engine pause reason from DCABot.js (scan still matches the source)');
ok(constUsed.size > 0, 'the engine sets reasons via the shared PR.* constants (the unification is in place)');

// Sanity: the reasons we know about today are present (so a refactor that renames one is caught here too).
for (const expected of ['order_verify_buy', 'buy_error', 'order_verify_sell', 'sell_error', 'sell_finalize_error', 'sell_partial_hold']) {
	ok(engineReasons.has(expected), 'engine still references the known pause reason ' + expected + ' (a rename would desync the UI)');
}

// THE WELD: every reason the engine references — constant OR literal — must exist in the single-source-of-truth
// taxonomy (and therefore be known to the UI, which reads the same module). Fails loudly, naming the offender,
// so a new money-path pause reason cannot ship without an entry in libs/app/pauseReasons.js.
for (const reason of engineReasons) {
	ok(VALID.has(reason),
		'engine pause reason "' + reason + '" is defined in libs/app/pauseReasons.js (the single source of truth shared by the money path and the UI — add it there, and set it in the engine via PR.' + reason.toUpperCase() + ')');
	ok(ui.systemPauseInfo(reason).isSystem === true && ui.systemPauseInfo(reason).description.length > 0,
		'engine pause reason "' + reason + '" renders as a system pause with a description in the (injected) UI');
}

console.log('systemPause: ' + passed + ' assertions passed');