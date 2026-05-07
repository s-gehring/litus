import type { AlertQueue } from "../alert-queue";
import type { ServerMessage } from "../protocol";
import type { Alert } from "../types";

export type BroadcastFn = (msg: ServerMessage) => void;

export interface AlertBroadcastListeners {
	/** Forward every alert that survives queue dedup AFTER the in-app
	 *  broadcast has fired. Errors are swallowed by the listener; the alert
	 *  pipeline never blocks on this. (Wires the Telegram notifier; FR-008.) */
	onAlertAccepted?: (alert: Alert) => void;
}

/**
 * Build the `onAlertEmit` pair plus the `markSeenWhere` helper that `server.ts`
 * wires into every orchestrator and the route-changed handler. Extracted so
 * tests can exercise the same glue that production uses.
 *
 * `getActivePaths` returns the set of paths currently viewed by connected
 * clients, used to decide create-as-seen (FR-007).
 */
export function createAlertBroadcasters(
	queue: AlertQueue,
	broadcast: BroadcastFn,
	getActivePaths: () => Iterable<string>,
	listeners?: AlertBroadcastListeners,
) {
	const emitAlert = (input: Omit<Alert, "id" | "createdAt" | "seen">): void => {
		let seen = false;
		if (input.type !== "error") {
			for (const path of getActivePaths()) {
				if (path === input.targetRoute) {
					seen = true;
					break;
				}
			}
		}
		const result = queue.emit({ ...input, seen });
		if (!result) return;
		broadcast({ type: "alert:created", alert: result.alert });
		if (result.evictedId) {
			broadcast({ type: "alert:dismissed", alertIds: [result.evictedId] });
		}
		if (listeners?.onAlertAccepted) {
			try {
				listeners.onAlertAccepted(result.alert);
			} catch {
				// Listener faults must never break the in-app alert path (FR-008).
			}
		}
	};

	/**
	 * Mark every alert matching the predicate as seen and broadcast the resulting
	 * id list as `alert:seen`. Defensive: never flips `type === "error"` to
	 * seen (FR-006) regardless of the caller's predicate.
	 */
	const markAlertsSeenWhere = (predicate: (a: Alert) => boolean): void => {
		const ids = queue.markSeenWhere((a) => a.type !== "error" && predicate(a));
		if (ids.length > 0) {
			broadcast({ type: "alert:seen", alertIds: ids });
		}
	};

	return { emitAlert, markAlertsSeenWhere };
}
