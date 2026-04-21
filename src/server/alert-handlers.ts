import type { ServerWebSocket } from "bun";
import type { MessageHandler, WsData } from "./handler-types";

/**
 * Drop the per-connection stored path on disconnect. Keeps `getActivePaths()`
 * from returning stale routes that would falsely flip new alerts to
 * create-as-seen after the client is gone (FR-007 invariant).
 */
export function clearClientRouteOnClose(
	ws: ServerWebSocket<WsData>,
	clientRoutes: Map<ServerWebSocket<WsData>, string>,
): void {
	clientRoutes.delete(ws);
}

export const handleAlertList: MessageHandler = (ws, _data, deps) => {
	deps.sendTo(ws, { type: "alert:list", alerts: deps.alertQueue.list() });
};

export const handleAlertDismiss: MessageHandler = (ws, data, deps) => {
	if (data.type !== "alert:dismiss") return;
	const removed = deps.alertQueue.dismiss(data.alertId);
	if (!removed) {
		deps.sendTo(ws, { type: "error", message: `Unknown alertId: ${data.alertId}` });
		return;
	}
	deps.broadcast({ type: "alert:dismissed", alertIds: [data.alertId] });
};

export const handleAlertClearAll: MessageHandler = (_ws, data, deps) => {
	if (data.type !== "alert:clear-all") return;
	const ids = deps.alertQueue.clearAll();
	if (ids.length === 0) return;
	deps.broadcast({ type: "alert:dismissed", alertIds: ids });
};

/**
 * Track the client's current path and auto-seen any non-error alerts whose
 * `targetRoute` matches. Error-exclusion is enforced by `markAlertsSeenWhere`
 * and, as defense-in-depth, by `AlertQueue.markSeenWhere` — no need to repeat
 * it in the predicate here.
 */
export const handleAlertRouteChanged: MessageHandler = (ws, data, deps) => {
	if (data.type !== "alert:route-changed") return;
	const raw = typeof data.path === "string" ? data.path : "";
	const path = raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
	if (!path) return;
	deps.clientRoutes.set(ws, path);
	deps.markAlertsSeenWhere((a) => a.targetRoute === path);
};
