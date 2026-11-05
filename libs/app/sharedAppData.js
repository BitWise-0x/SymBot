'use strict';

// SINGLE SOURCE OF TRUTH for the appData fields that must be IDENTICAL in a standalone instance and in the Hub.
//
// A standalone instance (symbot.js) and the Hub (symbot-hub.js) each build their own appData object, and they
// legitimately differ (ports, bots, exchanges, circuit breaker, … are instance-only). But some fields are
// GLOBAL/static and must be the same everywhere — e.g. the deal pause-reason taxonomy the frontend reads. Those
// used to be added by hand in BOTH entry points, which is exactly the drift trap ("change one, forget the
// other"). This module centralizes them: both entry points spread `commonFields()` into their appData, so a new
// shared field is added ONCE here and appears in both automatically.
//
// Pure and side-effect-free. Keep ONLY truly-shared, serializable, process-independent data here (nothing that
// depends on a specific instance's config, port, or exchange). Anything instance-specific stays in that entry
// point's own literal.

const PauseReasons = require(__dirname + '/pauseReasons.js');

function commonFields() {

	return {

		// Deal pause-reason taxonomy (libs/app/pauseReasons.js). Injected to the browser via EJS
		// (partialsHeaderView → window.SymBot.PAUSE_REASONS) so instance AND Hub deal views classify a pause
		// identically, and the money path (which sets reasons via PauseReasons.KEY) can never drift from the UI.
		'pause_reasons': PauseReasons.REASONS
	};
}

module.exports = { commonFields: commonFields };
