// Call record for a single mock invocation
export interface CallRecord {
	method: string;
	args: unknown[];
	returnValue?: unknown;
}

// Generic call tracker paired with every mock
export interface CallTracker {
	calls: CallRecord[];
	callsTo(method: string): CallRecord[];
	lastCallTo(method: string): CallRecord | undefined;
	callCount(method: string): number;
	reset(): void;
}

/** Create a new CallTracker that records CallRecord entries */
export function createCallTracker(): CallTracker {
	const calls: CallRecord[] = [];

	return {
		calls,
		callsTo(method: string): CallRecord[] {
			return calls.filter((c) => c.method === method);
		},
		lastCallTo(method: string): CallRecord | undefined {
			const matching = calls.filter((c) => c.method === method);
			return matching[matching.length - 1];
		},
		callCount(method: string): number {
			return calls.filter((c) => c.method === method).length;
		},
		reset(): void {
			calls.length = 0;
		},
	};
}
