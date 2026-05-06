// In-memory by design (R4): a server restart clears the unacknowledged-failure
// projection. The durable record of every delivery attempt lives in the JSONL
// audit log (`telegram-deliveries.jsonl`), so operator history isn't lost — only
// the badge state. Add persistence here if/when the badge needs to survive
// restarts.

export const MAX_RECENT_FAILURES = 20;

export interface TelegramFailureEntry {
	alertId: string;
	at: number;
	reason: string;
}

export interface TelegramStatusProjection {
	unacknowledgedCount: number;
	lastFailureReason: string | null;
	lastFailureAt: number | null;
}

export type TelegramStatusListener = (status: TelegramStatusProjection) => void;

export class TelegramFailureState {
	private recentFailures: TelegramFailureEntry[] = [];
	private acknowledgedAt = 0;
	private readonly listeners: TelegramStatusListener[] = [];
	private readonly now: () => number;

	constructor(options: { now?: () => number } = {}) {
		// `now` is overridable so unit tests can drive `acknowledgedAt` and
		// the per-failure timestamps deterministically.
		this.now = options.now ?? (() => Date.now());
	}

	recordFailure(alertId: string, reason: string): void {
		const at = this.now();
		this.recentFailures.unshift({ alertId, at, reason });
		if (this.recentFailures.length > MAX_RECENT_FAILURES) {
			this.recentFailures.length = MAX_RECENT_FAILURES;
		}
		this.notify();
	}

	acknowledge(): void {
		this.acknowledgedAt = this.now();
		this.notify();
	}

	getStatus(): TelegramStatusProjection {
		const head = this.recentFailures[0];
		return {
			unacknowledgedCount: this.recentFailures.filter((f) => f.at > this.acknowledgedAt).length,
			lastFailureReason: head?.reason ?? null,
			lastFailureAt: head?.at ?? null,
		};
	}

	subscribe(listener: TelegramStatusListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	private notify(): void {
		const snapshot = this.getStatus();
		for (const l of this.listeners) {
			try {
				l(snapshot);
			} catch {
				// Listener faults are isolated; the failure state itself is unaffected.
			}
		}
	}
}
