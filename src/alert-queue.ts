import { randomUUID } from "node:crypto";
import type { AlertStore } from "./alert-store";
import { logger } from "./logger";
import type { Alert, AlertType } from "./types";

const MAX_ALERTS = 100;
const DEDUP_WINDOW_MS = 5000;

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
	 */
	emit(input: Omit<Alert, "id" | "createdAt">): { alert: Alert; evictedId: string | null } | null {
		const now = this.now();
		const key = dedupKey(input.type, input.workflowId, input.epicId);
		const last = this.dedupKeys.get(key);
		if (last !== undefined && now - last < this.dedupWindowMs) {
			return null;
		}

		const alert: Alert = { ...input, id: makeAlertId(), createdAt: now };

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

	dismissWhere(filter: { type: AlertType; workflowId?: string; epicId?: string }): string[] {
		const removed: string[] = [];
		this.alerts = this.alerts.filter((a) => {
			const match =
				a.type === filter.type &&
				(filter.workflowId === undefined || a.workflowId === filter.workflowId) &&
				(filter.epicId === undefined || a.epicId === filter.epicId);
			if (match) removed.push(a.id);
			return !match;
		});
		if (removed.length > 0) this.persist();
		return removed;
	}

	private persist(): void {
		// Snapshot current state; persist fire-and-forget via AlertStore's own lock.
		const snapshot = [...this.alerts];
		this.store.save(snapshot).catch((err) => {
			logger.error(`[alert-queue] Failed to persist alerts: ${err}`);
		});
	}
}
