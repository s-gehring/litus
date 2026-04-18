import type { Alert } from "../../types";
import type { ClientStateManager } from "../client-state-manager";

function firstLine(s: string): string {
	const idx = s.search(/[\r\n]/);
	const line = idx === -1 ? s : s.slice(0, idx);
	return line.trim();
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n - 1)}\u2026`;
}

/**
 * Resolves the user-facing label for an alert, preferring live workflow/epic
 * summary text over any raw identifier. Returns "" when nothing readable exists
 * — callers must NOT fall back to the alert's id/hash.
 */
export function alertDisplayLabel(alert: Alert, state: ClientStateManager, maxLen = 60): string {
	if (alert.workflowId) {
		const wf = state.getWorkflows().get(alert.workflowId)?.state;
		if (wf?.summary) return truncate(wf.summary, maxLen);
		if (wf?.specification) {
			const line = firstLine(wf.specification);
			if (line) return truncate(line, maxLen);
		}
	}
	if (alert.epicId) {
		const agg = state.getEpicAggregates().get(alert.epicId);
		if (agg?.title) return truncate(agg.title, maxLen);
		const epic = state.getEpics().get(alert.epicId);
		if (epic?.title) return truncate(epic.title, maxLen);
	}
	return "";
}
