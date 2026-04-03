'use strict';

let shareData;

const API_ROOM = 'api';

// Maximum concurrent in-flight requests per client
const MAX_CONCURRENT_REQUESTS = 5;

// Timeout in milliseconds for each handler before returning an error
const HANDLER_TIMEOUT_MS = 15000;


const apiHandlers = {
	'deals':           apiDeals,
	'deals/show':      apiDealsShow,
	'deals/completed': apiDealsCompleted,
	'bots':            apiBots,
	'balances':        apiBalances,
	'markets':         apiMarkets,
	'markets/ohlcv':   apiMarketsOhlcv
};


async function apiDeals() {

	const req = {
		params: { path: '' },
		query:  { active: true }
	};

	return shareData.DCABotManager.apiGetActiveDeals(req, undefined, false);
}


async function apiMarkets(data) {

	const req = {
		params: { path: '' },
		query: {
			exchange:  data.exchange,
			pair:      data.pair
		}
	};

	return shareData.DCABotManager.apiGetMarkets(req, undefined, false);
}


async function apiMarketsOhlcv(data) {

	const req = {
		params: { path: 'ohlcv' },
		query: {
			exchange:  data.exchange,
			pair:      data.pair,
			timeframe: data.timeframe,
			since:     data.since,
			limit:     data.limit
		}
	};

	return shareData.DCABotManager.apiGetMarkets(req, undefined, false);
}



async function apiDealsShow(data) {

	const dealId = data.dealId;

	const req = {
		params: { dealId: dealId },
		query:  {}
	};

	return shareData.DCABotManager.apiShowDeal(req, undefined, dealId, false);
}


async function apiDealsCompleted(data) {

	const req = {
		params: {},
		query: {
			from:           data.from,
			to:             data.to,
			timeZoneOffset: data.timeZoneOffset,
			botId:          data.botId
		}
	};

	return shareData.DCABotManager.apiGetDealsHistory(req, undefined, false);
}


async function apiBots(data) {

	const req = {
		params: {},
		query:  { active: data.active }
	};

	return shareData.DCABotManager.apiGetBots(req, undefined, false);
}


async function apiBalances() {

	return shareData.DCABotManager.apiGetBalances(undefined, undefined, false);
}


// Wraps a handler Promise with a timeout. Rejects with a clear message
// if the handler does not resolve within HANDLER_TIMEOUT_MS.
function withTimeout(promise, ms) {

	return new Promise((resolve, reject) => {

		const timer = setTimeout(() => {

			reject(new Error('Request timed out after ' + ms + 'ms'));

		}, ms);

		promise.then(

			(result) => { clearTimeout(timer); resolve(result); },
			(err)    => { clearTimeout(timer); reject(err); }
		);
	});
}


// Sends a structured response back to the requesting client.
// Used for both successful results and errors so the client always
// receives a reply for every api_action it sends.
function sendResponse(client, apiName, appId, messageId, message, error) {

	client.emit('data', {
		'type':              'api',
		'api':               apiName,
		'app_id':            appId,
		'message_id':        shareData.Common.uuidv4(),
		'message_id_client': messageId,
		'message':           message,
		'error':             error || null
	});
}


async function api(client, data, inflightMap) {

	const metaData  = data.meta || {};
	const apiName   = metaData.api;
	const appId     = metaData.appId;
	const messageId = metaData.id;

	// Ensure client is in api room
	if (!client.rooms.has(API_ROOM)) {

		sendResponse(client, apiName, appId, messageId, null, 'Not registered. Emit register_client first.');
		return;
	}

	const handler = apiHandlers[apiName];

	if (!handler) {

		sendResponse(client, apiName, appId, messageId, null, 'Unknown API: ' + apiName);
		return;
	}

	// Rate limit — cap concurrent in-flight requests per client
	const inFlight = inflightMap.get(client.id) || 0;

	if (inFlight >= MAX_CONCURRENT_REQUESTS) {

		sendResponse(client, apiName, appId, messageId, null, 'Too many concurrent requests. Please wait.');
		return;
	}

	inflightMap.set(client.id, inFlight + 1);

	try {

		const message = await withTimeout(handler(data), HANDLER_TIMEOUT_MS);

		sendResponse(client, apiName, appId, messageId, message, null);
	}
	catch (e) {

		const errMsg = e?.message || 'Internal error';

		shareData.Common.logger('WebSocket API error [' + apiName + ']: ' + errMsg);

		sendResponse(client, apiName, appId, messageId, null, errMsg);
	}
	finally {

		const current = inflightMap.get(client.id) || 1;

		if (current <= 1) {
			inflightMap.delete(client.id);
		}
		else {
			inflightMap.set(client.id, current - 1);
		}
	}
}


module.exports = {

	api,

	init(obj) {

		shareData = obj;
	}
};
