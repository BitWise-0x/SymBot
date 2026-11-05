'use strict';

// grade.js — the SINGLE SOURCE OF TRUTH for how a money-path eval assertion is decided. Pure and
// dependency-free: a driver produces an `outcome` object, and a scenario's declarative checks are evaluated
// here. Both the CLI runner and the deterministic gate test import this exact module, so they can never grade
// the same scenario two different ways.
//
// A check is one of: { field, equals } | { close } | { atLeast } | { atMost } | { is } | { contains } | { oneOf }.
//   equals  — numeric within FLOAT_TOL, or strict-equal for non-numbers
//   close   — numeric within an explicit { close, tol }
//   atLeast / atMost — numeric bound
//   is      — strict === (true/false/null/string)
//   contains — the field (string) includes the given substring (case-insensitive)
//   oneOf   — the field strictly equals one of the given array values

const FLOAT_TOL = 1e-9;

// Read a dotted path ("verdict.tradable") out of an object; returns undefined if any hop is missing.
function getPath(obj, path) {
	if (obj == null) { return undefined; }
	const parts = String(path).split('.');
	let cur = obj;
	for (let i = 0; i < parts.length; i++) {
		if (cur == null) { return undefined; }
		cur = cur[parts[i]];
	}
	return cur;
}

function numericEqual(a, b, tol) {
	const x = Number(a), y = Number(b);
	if (!isFinite(x) || !isFinite(y)) { return false; }
	return Math.abs(x - y) <= (tol == null ? FLOAT_TOL : tol);
}

// Evaluate ONE check against an outcome. Returns { ok, detail } — detail is a short human string on failure.
function checkAssertion(outcome, check) {

	const field = check.field;
	const actual = getPath(outcome, field);
	const show = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

	if (Object.prototype.hasOwnProperty.call(check, 'equals')) {
		const want = check.equals;
		const ok = (typeof want === 'number') ? numericEqual(actual, want) : (actual === want);
		return { ok, detail: ok ? '' : field + ' = ' + show(actual) + ', want ' + show(want) };
	}
	if (Object.prototype.hasOwnProperty.call(check, 'close')) {
		const ok = numericEqual(actual, check.close, check.tol);
		return { ok, detail: ok ? '' : field + ' = ' + show(actual) + ', want ~' + show(check.close) + ' (±' + (check.tol == null ? FLOAT_TOL : check.tol) + ')' };
	}
	if (Object.prototype.hasOwnProperty.call(check, 'atLeast')) {
		const ok = isFinite(Number(actual)) && Number(actual) >= Number(check.atLeast);
		return { ok, detail: ok ? '' : field + ' = ' + show(actual) + ', want >= ' + show(check.atLeast) };
	}
	if (Object.prototype.hasOwnProperty.call(check, 'atMost')) {
		const ok = isFinite(Number(actual)) && Number(actual) <= Number(check.atMost);
		return { ok, detail: ok ? '' : field + ' = ' + show(actual) + ', want <= ' + show(check.atMost) };
	}
	if (Object.prototype.hasOwnProperty.call(check, 'is')) {
		const ok = actual === check.is;
		return { ok, detail: ok ? '' : field + ' = ' + show(actual) + ', want (is) ' + show(check.is) };
	}
	if (Object.prototype.hasOwnProperty.call(check, 'contains')) {
		const ok = typeof actual === 'string' && actual.toLowerCase().includes(String(check.contains).toLowerCase());
		return { ok, detail: ok ? '' : field + ' = ' + show(actual) + ', want to contain "' + check.contains + '"' };
	}
	if (Object.prototype.hasOwnProperty.call(check, 'oneOf')) {
		const arr = Array.isArray(check.oneOf) ? check.oneOf : [];
		const ok = arr.some((v) => v === actual);
		return { ok, detail: ok ? '' : field + ' = ' + show(actual) + ', want one of ' + show(arr) };
	}

	return { ok: false, detail: 'unknown check for ' + field + ': ' + show(check) };
}

// Run a list of checks; returns the list of FAILURE details (empty = all passed).
function runChecks(outcome, checks) {
	const fails = [];
	(Array.isArray(checks) ? checks : []).forEach((c) => {
		let res;
		try { res = checkAssertion(outcome, c); }
		catch (e) { res = { ok: false, detail: 'check threw: ' + (e && e.message ? e.message : e) }; }
		if (!res.ok) { fails.push(res.detail); }
	});
	return fails;
}

module.exports = { getPath, numericEqual, checkAssertion, runChecks, FLOAT_TOL };
