'use strict';

// Deterministic gate for the money-path replay eval harness. It runs the SAME Harness.run() the CLI uses, over
// the committed scenarios, and fails the build if any hard check fails (or if nothing graded). Offline,
// deterministic, no live model and no exchange — every scenario drives a real money-path function against a
// scripted sequence. Soft `flag`s (e.g. the known #130 "remainder below break-even" gap) are informational and
// never fail the gate; they are reported so the gap stays visible.

const assert = require('assert');
const Harness = require('./Harness.js');

(async () => {

	let passed = 0;
	function ok(c, m) { assert.ok(c, m); passed++; }

	try {
		const res = await Harness.runAll();

		// A run that graded nothing is a FAILURE, not a silent pass.
		ok(res.summary.total > 0, 'at least one scenario ran (got ' + res.summary.total + ')');

		// Every HARD check must pass. Report any failures in full before asserting, so CI shows the cause.
		const failedRows = res.rows.filter((r) => !r.pass);
		if (failedRows.length) {
			failedRows.forEach((r) => {
				console.error('  ✗ [' + r.kind + '] ' + r.name + (r.file ? ' (' + r.file + ')' : ''));
				(r.failures || []).forEach((f) => console.error('        ' + f));
			});
		}
		ok(failedRows.length === 0, res.summary.failed + ' scenario(s) failed the hard gate');
		ok(res.verdict === 'PASS', 'verdict is PASS');

		// Surface soft flags (not a failure) so a known gap does not silently disappear.
		res.rows.forEach((r) => {
			(r.flags || []).forEach((f) => console.log('  • flag [' + r.name + ']: ' + f));
		});

		console.log('MoneyPathEval: ' + res.summary.total + ' scenarios passed (' + res.summary.flagged + ' flagged), ' + passed + ' assertions');
		process.exit(0);
	}
	catch (e) {
		console.error('MoneyPathEval FAIL: ' + (e && e.stack ? e.stack : e));
		process.exit(1);
	}
})();
