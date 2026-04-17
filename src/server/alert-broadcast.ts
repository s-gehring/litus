import type { AlertQueue } from "../alert-queue";
import type { Alert, AlertType, ServerMessage } from "../types";

export type BroadcastFn = (msg: ServerMessage) => void;

/**
 * Build the `onAlertEmit` / `onAlertDismissWhere` pair that `server.ts` wires
 * into every orchestrator. Extracted so tests can exercise the same glue that
 * production uses.
 */
export function createAlertBroadcasters(queue: AlertQueue, broadcast: BroadcastFn) {
	const emitAlert = (input: Omit<Alert, "id" | "createdAt">): void => {
		const result = queue.emit(input);
		if (!result) return;
		broadcast({ type: "alert:created", alert: result.alert });
		if (result.evictedId) {
			broadcast({ type: "alert:dismissed", alertIds: [result.evictedId] });
		}
	};

	const dismissAlertsWhere = (filter: {
		type: AlertType;
		workflowId?: string;
		epicId?: string;
	}): void => {
		const removed = queue.dismissWhere(filter);
		if (removed.length > 0) {
			broadcast({ type: "alert:dismissed", alertIds: removed });
		}
	};

	return { emitAlert, dismissAlertsWhere };
}
