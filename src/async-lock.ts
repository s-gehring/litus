/**
 * Promise-based async lock that serializes concurrent calls.
 * Each call waits for the previous to complete before executing.
 */
export class AsyncLock {
	private pending: Promise<void> = Promise.resolve();
	private inFlight = false;

	async run<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.pending;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.pending = promise;
		try {
			await prev;
			this.inFlight = true;
			return await fn();
		} finally {
			this.inFlight = false;
			resolve();
		}
	}

	/**
	 * Non-blocking variant. Returns `null` immediately when the lock is held by
	 * an already-executing `run`/`tryRun`; otherwise executes `fn` and returns
	 * its promise. Intended for operations that must reject rather than queue
	 * on contention (e.g. the per-epic feedback submission lock).
	 */
	tryRun<T>(fn: () => Promise<T>): Promise<T> | null {
		if (this.inFlight) return null;
		this.inFlight = true;
		const prev = this.pending;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.pending = promise;
		return (async () => {
			try {
				await prev;
				return await fn();
			} finally {
				this.inFlight = false;
				resolve();
			}
		})();
	}
}
