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
