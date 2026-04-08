/**
 * Promise-based async lock that serializes concurrent calls.
 * Each call waits for the previous to complete before executing.
 */
export class AsyncLock {
	private pending: Promise<void> = Promise.resolve();

	async run<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.pending;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.pending = promise;
		try {
			await prev;
			return await fn();
		} finally {
			resolve();
		}
	}
}
