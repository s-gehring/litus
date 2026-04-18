import type { ClientStateManager } from "../client-state-manager";

export const BACK_TO_EPIC_PREFIX = "\u2190 Back to ";
export const BACK_TO_EPIC_FALLBACK_TITLE = "epic";

/**
 * Resolves the human-readable title of the epic the workflow belongs to, in
 * this priority order: aggregated epic title → epic analysis title → literal
 * `"epic"` fallback. Only the title is returned — callers compose the full
 * label by prefixing `← Back to ` (see BACK_TO_EPIC_PREFIX).
 */
export function backToEpicLabel(epicId: string, state: ClientStateManager): string {
	const agg = state.getEpicAggregates().get(epicId);
	if (agg?.title) return agg.title;
	const epic = state.getEpics().get(epicId);
	if (epic?.title) return epic.title;
	return BACK_TO_EPIC_FALLBACK_TITLE;
}
