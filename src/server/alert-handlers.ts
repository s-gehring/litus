import type { MessageHandler } from "./handler-types";

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
	const path = typeof data.path === "string" ? data.path : "";
	if (!path) return;
	deps.clientRoutes.set(ws, path);
	deps.markAlertsSeenWhere((a) => a.targetRoute === path);
};
