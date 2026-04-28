import { EPIC_CARD_PREFIX } from "../components/status-maps";
import type { EpicSliceState, WorkflowSliceState } from "./types";

export function rebuildCardOrder(
	out: string[],
	workflowState: WorkflowSliceState,
	epicState: EpicSliceState,
): void {
	out.length = 0;
	const seenEpics = new Set<string>();
	const items: { key: string; sortDate: string }[] = [];

	for (const [, entry] of workflowState.workflows) {
		const wf = entry.state;
		if (wf.archived) continue;
		if (wf.epicId) {
			const parentEpic = epicState.epics.get(wf.epicId);
			if (parentEpic?.archived) continue;
			if (seenEpics.has(wf.epicId)) continue;
			seenEpics.add(wf.epicId);
			const agg = epicState.epicAggregates.get(wf.epicId);
			items.push({
				key: `${EPIC_CARD_PREFIX}${wf.epicId}`,
				sortDate: agg?.startDate ?? wf.createdAt,
			});
		} else {
			items.push({ key: wf.id, sortDate: wf.createdAt });
		}
	}

	for (const [epicId, epic] of epicState.epics) {
		if (epic.archived) continue;
		if (!seenEpics.has(epicId) && epic.workflowIds.length === 0) {
			items.push({ key: epicId, sortDate: epic.startedAt });
		}
	}

	items.sort((a, b) => b.sortDate.localeCompare(a.sortDate));
	for (const item of items) out.push(item.key);
}
