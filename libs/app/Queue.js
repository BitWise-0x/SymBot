'use strict';

let shareData;


// Creates a serial async queue — tasks run one at a time, each waiting for
// the previous to complete before starting. This prevents race conditions
// when multiple deal start requests arrive simultaneously.
//
// Usage:
//   const queue = await create();
//   await queue.enqueue(() => myAsyncFn(arg1, arg2));
//
// The enqueued function must return a Promise (async functions qualify).
// The queue resolves each task's Promise before starting the next one.

async function create() {

	// The chain is a Promise that always resolves. Each new task is appended
	// via .then() so it only runs after the previous task settles.
	let chain = Promise.resolve();

	const enqueue = (fn) => {

		const taskPromise = new Promise((resolve, reject) => {

			chain = chain.then(async () => {

				try {

					const result = await fn();

					resolve(result);
				}
				catch (err) {

					// Log but don't break the chain — the next task should still run
					try {

						shareData.Common.logger('Queue task error: ' + (err?.message || String(err)));
					}
					catch(e) {}

					reject(err);
				}
			});
		});

		return taskPromise;
	};


	return { enqueue };
}


module.exports = {

	create,

	init: function(obj) {

		shareData = obj;
	},
};
