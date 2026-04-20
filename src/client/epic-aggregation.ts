import type { EpicAggregatedState, EpicAggregatedStatus, WorkflowState } from "../types";

export function computeEpicAggregatedState(children: WorkflowState[]): EpicAggregatedState | null {
	if (children.length === 0) return null;

	const epicId = children[0].epicId;
	if (!epicId) return null;

	// Scan all children for a non-null epicTitle (first child may lack it during race conditions)
	const title = children.find((c) => c.epicTitle)?.epicTitle ?? null;
	if (!title) return null;

	let status: EpicAggregatedStatus = "idle";
	let completed = 0;

	const hasRunning = children.some((c) => c.status === "running");
	const hasError = children.some((c) => c.status === "error" || c.status === "aborted");
	const hasPaused = children.some((c) => c.status === "paused");
	const hasWaiting = children.some((c) => c.status === "waiting_for_input");
	const hasWaitingDeps = children.some((c) => c.status === "waiting_for_dependencies");

	for (const c of children) {
		if (c.status === "completed") completed++;
	}

	if (hasRunning) status = "running";
	else if (hasError) status = "error";
	else if (hasPaused) status = "paused";
	else if (hasWaiting) status = "waiting";
	else if (hasWaitingDeps) status = "in_progress";
	else if (completed === children.length) status = "completed";
	else status = "idle";

	// Start date = min(createdAt)
	let startDate = children[0].createdAt;
	for (const c of children) {
		if (c.createdAt < startDate) startDate = c.createdAt;
	}

	// Sum active work time across children (including epic analysis time)
	let totalActiveWorkMs = 0;
	let anyActiveWorkStartedAt: string | null = null;
	for (const c of children) {
		totalActiveWorkMs += c.activeWorkMs + (c.epicAnalysisMs ?? 0);
		if (c.activeWorkStartedAt) {
			if (!anyActiveWorkStartedAt || c.activeWorkStartedAt < anyActiveWorkStartedAt) {
				anyActiveWorkStartedAt = c.activeWorkStartedAt;
			}
		}
	}

	return {
		epicId,
		title,
		status,
		progress: { completed, total: children.length },
		startDate,
		activeWorkMs: totalActiveWorkMs,
		activeWorkStartedAt: anyActiveWorkStartedAt,
		childWorkflowIds: children.map((c) => c.id),
	};
}
