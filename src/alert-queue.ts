import { randomUUID } from "node:crypto";
import type { AlertStore } from "./alert-store";
import { logger } from "./logger";
import type { Alert, AlertType } from "./types";

const MAX_ALERTS = 100;
const DEDUP_WINDOW_MS = 5000;
const MAX_TITLE_LEN = 120;
const MAX_DESCRIPTION_LEN = 500;

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export interface AlertQueueOptions {
	now?: () => number;
	maxAlerts?: number;
	dedupWindowMs?: number;
}

function dedupKey(type: AlertType, workflowId: string | null, epicId: string | null): string {
	return `${type}:${workflowId ?? epicId ?? ""}`;
}

function makeAlertId(): string {
	return `alert_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export class AlertQueue {
	private alerts: Alert[] = [];
	private dedupKeys = new Map<string, number>();
	private readonly store: AlertStore;
	private readonly now: () => number;
	private readonly maxAlerts: number;
	private readonly dedupWindowMs: number;

	constructor(store: AlertStore, options: AlertQueueOptions = {}) {
		this.store = store;
		this.now = options.now ?? (() => Date.now());
		this.maxAlerts = options.maxAlerts ?? MAX_ALERTS;
		this.dedupWindowMs = options.dedupWindowMs ?? DEDUP_WINDOW_MS;
	}

	async loadFromDisk(): Promise<void> {
		const loaded = await this.store.load();
		this.alerts = [...loaded].sort((a, b) => a.createdAt - b.createdAt);
		this.dedupKeys.clear();
		for (const a of this.alerts) {
			const key = dedupKey(a.type, a.workflowId, a.epicId);
			const prev = this.dedupKeys.get(key) ?? 0;
			if (a.createdAt > prev) this.dedupKeys.set(key, a.createdAt);
		}
	}

	list(): Alert[] {
		return [...this.alerts].sort((a, b) => b.createdAt - a.createdAt);
	}

	/**
	 * Emit a new alert. Returns the alert and an optional evicted id when the
	 * 100-alert cap forced oldest-eviction. Returns null when suppressed by the
	 * 5 s `(type, workflowId|epicId)` dedup window.
	 *
	 * The optional `seen` flag is pre-computed by `createAlertBroadcasters` based
	 * on active client routes (FR-007 create-as-seen). Other callers should omit
	 * it — passing `true` would bypass the create-as-seen invariant that only
	 * applies when a live client already views the target route.
	 */
	emit(
		input: Omit<Alert, "id" | "createdAt" | "seen"> & { seen?: boolean },
	): { alert: Alert; evictedId: string | null } | null {
		const now = this.now();
		const key = dedupKey(input.type, input.workflowId, input.epicId);
		const last = this.dedupKeys.get(key);
		if (last !== undefined && now - last < this.dedupWindowMs) {
			return null;
		}

		const alert: Alert = {
			...input,
			title: truncate(input.title, MAX_TITLE_LEN),
			description: truncate(input.description, MAX_DESCRIPTION_LEN),
			id: makeAlertId(),
			createdAt: now,
			seen: input.seen ?? false,
		};

		let evictedId: string | null = null;
		if (this.alerts.length >= this.maxAlerts) {
			const oldest = this.alerts.shift();
			if (oldest) evictedId = oldest.id;
		}
		this.alerts.push(alert);
		this.dedupKeys.set(key, now);

		this.persist();
		return { alert, evictedId };
	}

	dismiss(alertId: string): boolean {
		const idx = this.alerts.findIndex((a) => a.id === alertId);
		if (idx < 0) return false;
		this.alerts.splice(idx, 1);
		this.persist();
		return true;
	}

	/**
	 * Flip `seen = true` on every alert matching the predicate that is not
	 * already seen and is not an error. Returns the ids of alerts that changed
	 * state. Error alerts are filtered at this layer as defense-in-depth for
	 * FR-006; the broadcaster (`createAlertBroadcasters`) also filters them so
	 * the invariant holds even if a new caller wires directly into the queue.
	 */
	markSeenWhere(predicate: (a: Alert) => boolean): string[] {
		const changed: string[] = [];
		for (const a of this.alerts) {
			if (!a.seen && a.type !== "error" && predicate(a)) {
				a.seen = true;
				changed.push(a.id);
			}
		}
		if (changed.length > 0) this.persist();
		return changed;
	}

	/**
	 * Drop every alert and reset the dedup window. Returns the IDs that were
	 * cleared so the caller can broadcast `alert:dismissed` to live clients.
	 * Used by the purge flow so purged state does not resurrect on reconnect.
	 */
	clearAll(): string[] {
		const ids = this.alerts.map((a) => a.id);
		this.alerts = [];
		this.dedupKeys.clear();
		this.persist();
		return ids;
	}

	/**
	 * Awaits the most recent pending persist. Useful for tests and graceful
	 * shutdown paths where we want the on-disk snapshot to reflect the latest
	 * mutation before the process exits.
	 */
	async flush(): Promise<void> {
		if (this.pendingPersist) {
			try {
				await this.pendingPersist;
			} catch {
				// Errors are already logged by `persist`.
			}
		}
	}

	private pendingPersist: Promise<void> | null = null;

	private persist(): void {
		// Snapshot current state; persist fire-and-forget via AlertStore's own lock.
		const snapshot = [...this.alerts];
		this.pendingPersist = this.store.save(snapshot).catch((err) => {
			logger.error(`[alert-queue] Failed to persist alerts: ${err}`);
		});
	}
}
