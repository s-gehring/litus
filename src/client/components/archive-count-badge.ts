import type { ClientStateManager } from "../client-state-manager";

export function updateArchiveCount(stateManager: ClientStateManager): void {
	const el = document.getElementById("archive-count");
	if (!el) return;
	let workflows = 0;
	for (const [, entry] of stateManager.getWorkflows()) {
		if (entry.state.archived) workflows++;
	}
	let epics = 0;
	for (const [, epic] of stateManager.getEpics()) {
		if (epic.archived) epics++;
	}
	el.textContent = String(workflows + epics);
}
