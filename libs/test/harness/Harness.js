'use strict';

// Harness.js — the money-path replay eval runner. It loads declarative scenarios, drives each through the REAL
// money-path function for its `kind` (drivers.js), and grades the outcome with two tiers:
//   • expect  — HARD checks that gate the run (a failure here fails the verdict).
//   • flag    — SOFT checks for triage only (recorded, never fails the gate — e.g. a known gap not yet fixed).
//
// Fully fail-safe (a scenario that throws is an error row, never aborts the run), sequential (cannot spike
// memory or hammer anything), and dependency-light. A run that graded NOTHING is a FAILURE, never a silent
// pass. Both the CLI and the deterministic gate test call run() / loadScenarios() here, so there is one runner.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const grade = require('./grade.js');
const { runDriver } = require('./drivers.js');

const SCENARIO_DIR = path.join(__dirname, 'scenarios');

// Load every *.json scenario file from a directory. A file may hold a single scenario object or
// { scenarios: [...] }. Non-blocking; returns a flat array. Never throws — a bad file is skipped with a note.
async function loadScenarios(dir) {
	dir = dir || SCENARIO_DIR;
	const out = [];
	let names;
	try { names = await fsp.readdir(dir); }
	catch (e) { return out; }

	for (const name of names.sort()) {
		if (!name.endsWith('.json')) { continue; }
		const full = path.join(dir, name);
		try {
			const parsed = JSON.parse(await fsp.readFile(full, 'utf8'));
			const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.scenarios) ? parsed.scenarios : [ parsed ]);
			list.forEach((s) => { if (s && s.kind) { out.push(Object.assign({ _file: name }, s)); } });
		}
		catch (e) { out.push({ _file: name, kind: '_loaderror', name: name + ' (parse error)', _error: (e && e.message) || String(e) }); }
	}
	return out;
}

// Run a single scenario → a graded row. Never throws.
async function runScenario(scn) {
	const row = { name: scn.name || '(unnamed)', kind: scn.kind, tags: Array.isArray(scn.tags) ? scn.tags : [], file: scn._file || '', failures: [], flags: [], pass: true };

	if (scn.kind === '_loaderror') {
		row.failures.push('scenario file failed to load: ' + (scn._error || 'parse error'));
		row.pass = false;
		return row;
	}

	let outcome = null;
	try {
		outcome = await runDriver(scn);
	}
	catch (e) {
		row.failures.push('driver threw: ' + (e && e.message ? e.message : e));
		row.pass = false;
		return row;
	}

	row.outcome = outcome;
	// HARD gate.
	row.failures = grade.runChecks(outcome, scn.expect);
	// SOFT flags (triage only).
	row.flags = grade.runChecks(outcome, scn.flag);
	row.pass = row.failures.length === 0;
	return row;
}

// Run a whole set. Returns { at, rows, summary, verdict }. opts.onProgress({ done, total, row }) is optional.
async function run(scenarios, opts = {}) {
	const list = Array.isArray(scenarios) ? scenarios : [];
	const rows = [];
	for (let i = 0; i < list.length; i++) {
		const row = await runScenario(list[i]);
		rows.push(row);
		if (typeof opts.onProgress === 'function') { try { opts.onProgress({ done: i + 1, total: list.length, row }); } catch (e) { /* ignore */ } }
	}

	const passed = rows.filter((r) => r.pass).length;
	const failed = rows.length - passed;
	const flagged = rows.filter((r) => r.flags && r.flags.length).length;
	// A run that graded nothing is a FAILURE, not a silent pass.
	const verdict = (rows.length > 0 && failed === 0) ? 'PASS' : 'FAIL';

	return {
		at: new Date().toISOString(),
		rows,
		summary: { total: rows.length, passed, failed, flagged },
		verdict
	};
}

// Convenience: load the default scenario dir and run it.
async function runAll(dir) {
	const scenarios = await loadScenarios(dir);
	return run(scenarios);
}

module.exports = { run, runScenario, runAll, loadScenarios, SCENARIO_DIR };
