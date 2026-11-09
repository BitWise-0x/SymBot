'use strict';

// cli.js — one-command money-path eval. Loads every scenario, drives each through the real money-path
// function, grades it, prints a readable report, and EXITS with the verdict (0 = PASS, 1 = FAIL) so it drops
// straight into CI or a pre-commit hook. `--json` prints the machine-readable result instead.
//
//   node libs/test/harness/cli.js
//   node libs/test/harness/cli.js --json
//
// The deterministic gate test (MoneyPathEval.test.js) uses the same Harness.run(), so the CLI and the gate can
// never disagree about a verdict.

const Harness = require('./Harness.js');

(async () => {

	const asJson = process.argv.includes('--json');

	let res;
	try {
		res = await Harness.runAll();
	}
	catch (e) {
		// A harness that cannot even run is a FAILURE, never a silent pass.
		if (asJson) { process.stdout.write(JSON.stringify({ verdict: 'FAIL', error: (e && e.message) || String(e) }) + '\n'); }
		else { process.stdout.write('money-path eval: FAILED TO RUN — ' + ((e && e.message) || e) + '\n'); }
		process.exit(1);
		return;
	}

	if (asJson) {
		process.stdout.write(JSON.stringify(res, null, 2) + '\n');
		process.exit(res.verdict === 'PASS' ? 0 : 1);
		return;
	}

	const lines = [];
	lines.push('');
	lines.push('money-path replay eval:');
	for (const r of res.rows) {
		const mark = r.pass ? (r.flags && r.flags.length ? '  •' : '  ok') : '  ✗';
		lines.push(mark + '  [' + r.kind + '] ' + r.name);
		if (r.failures && r.failures.length) { r.failures.forEach((f) => lines.push('         ✗ ' + f)); }
		if (r.flags && r.flags.length) { r.flags.forEach((f) => lines.push('         • flag: ' + f)); }
	}
	const s = res.summary;
	lines.push('');
	lines.push('--- ' + s.total + ' scenarios: ' + s.passed + ' passed, ' + s.failed + ' failed, ' + s.flagged + ' flagged ---');
	lines.push('VERDICT: ' + res.verdict);
	lines.push('');
	process.stdout.write(lines.join('\n') + '\n');

	process.exit(res.verdict === 'PASS' ? 0 : 1);
})();
