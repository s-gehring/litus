import { describe, expect, test } from "bun:test";

// We test computeEpicAggregatedState by importing from app.ts
// Since app.ts has DOM dependencies, we'll test the logic inline
import type { EpicAggregatedState, EpicAggregatedStatus, WorkflowState } from "../src/types";

function mustGet(result: EpicAggregatedState | null): EpicAggregatedState {
	if (!result) throw new Error("Expected non-null result");
	return result;
}

// Re-implement the pure function for testing (same logic as in app.ts)
function computeEpicAggregatedState(children: WorkflowState[]) {
	if (children.length === 0) return null;

	const epicId = children[0].epicId;
	const title = children[0].epicTitle;
	if (!epicId || !title) return null;

	let status: EpicAggregatedStatus = "idle";
	let completed = 0;

	const hasRunning = children.some((c) => c.status === "running");
	const hasError = children.some((c) => c.status === "error" || c.status === "cancelled");
	const hasWaiting = children.some((c) => c.status === "waiting_for_input");
	const hasWaitingDeps = children.some((c) => c.status === "waiting_for_dependencies");

	for (const c of children) {
		if (c.status === "completed") completed++;
	}

	if (hasRunning) status = "running";
	else if (hasError) status = "error";
	else if (hasWaiting) status = "waiting";
	else if (hasWaitingDeps) status = "in_progress";
	else if (completed === children.length) status = "completed";
	else status = "idle";

	let startDate = children[0].createdAt;
	for (const c of children) {
		if (c.createdAt < startDate) startDate = c.createdAt;
	}

	return {
		epicId,
		title,
		status,
		progress: { completed, total: children.length },
		startDate,
		childWorkflowIds: children.map((c) => c.id),
	};
}

function makeChild(overrides: Partial<WorkflowState> & { id: string }): WorkflowState {
	return {
		id: overrides.id,
		specification: "test spec",
		status: overrides.status ?? "idle",
		targetRepository: null,
		worktreePath: null,
		worktreeBranch: "test-branch",
		summary: overrides.summary ?? "Test",
		stepSummary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: [],
		currentStepIndex: 0,
		reviewCycle: { iteration: 0, maxIterations: 3, lastSeverity: null },
		ciCycle: {
			attempt: 0,
			maxAttempts: 3,
			monitorStartedAt: null,
			globalTimeoutMs: 600000,
			lastCheckResults: [],
			failureLogs: [],
		},
		mergeCycle: { attempt: 0, maxAttempts: 3 },
		prUrl: null,
		epicId: "epicId" in overrides ? (overrides.epicId ?? null) : "epic-1",
		epicTitle: "epicTitle" in overrides ? (overrides.epicTitle ?? null) : "Test Epic",
		epicDependencies: overrides.epicDependencies ?? [],
		epicDependencyStatus: overrides.epicDependencyStatus ?? null,
		activeWorkMs: 0,
		activeWorkStartedAt: null,
		createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
		updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
	};
}

describe("computeEpicAggregatedState", () => {
	test("returns null for empty children", () => {
		expect(computeEpicAggregatedState([])).toBeNull();
	});

	test("returns null if no epicId", () => {
		const child = makeChild({ id: "a", epicId: null, epicTitle: null });
		expect(computeEpicAggregatedState([child])).toBeNull();
	});

	test("single idle child -> idle status", () => {
		const child = makeChild({ id: "a", status: "idle" });
		const result = computeEpicAggregatedState([child]);
		expect(result).not.toBeNull();
		expect(result?.status).toBe("idle");
		expect(result?.progress).toEqual({ completed: 0, total: 1 });
	});

	test("running takes priority over everything", () => {
		const children = [
			makeChild({ id: "a", status: "running" }),
			makeChild({ id: "b", status: "error" }),
			makeChild({ id: "c", status: "completed" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("running");
	});

	test("error takes priority over waiting", () => {
		const children = [
			makeChild({ id: "a", status: "error" }),
			makeChild({ id: "b", status: "waiting_for_input" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("error");
	});

	test("waiting takes priority over in_progress", () => {
		const children = [
			makeChild({ id: "a", status: "waiting_for_input" }),
			makeChild({ id: "b", status: "waiting_for_dependencies" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("waiting");
	});

	test("waiting_for_dependencies -> in_progress", () => {
		const children = [
			makeChild({ id: "a", status: "completed" }),
			makeChild({ id: "b", status: "waiting_for_dependencies" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("in_progress");
	});

	test("all completed -> completed", () => {
		const children = [
			makeChild({ id: "a", status: "completed" }),
			makeChild({ id: "b", status: "completed" }),
			makeChild({ id: "c", status: "completed" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("completed");
		expect(result.progress).toEqual({ completed: 3, total: 3 });
	});

	test("mixed idle and completed -> idle", () => {
		const children = [
			makeChild({ id: "a", status: "idle" }),
			makeChild({ id: "b", status: "completed" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("idle");
		expect(result.progress).toEqual({ completed: 1, total: 2 });
	});

	test("cancelled counts as error", () => {
		const children = [
			makeChild({ id: "a", status: "cancelled" }),
			makeChild({ id: "b", status: "completed" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("error");
	});

	test("start date is min of all createdAt", () => {
		const children = [
			makeChild({ id: "a", createdAt: "2026-01-03T00:00:00Z" }),
			makeChild({ id: "b", createdAt: "2026-01-01T00:00:00Z" }),
			makeChild({ id: "c", createdAt: "2026-01-02T00:00:00Z" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.startDate).toBe("2026-01-01T00:00:00Z");
	});

	test("preserves epic metadata", () => {
		const children = [
			makeChild({ id: "a", epicId: "epic-42", epicTitle: "My Epic" }),
			makeChild({ id: "b", epicId: "epic-42", epicTitle: "My Epic" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.epicId).toBe("epic-42");
		expect(result.title).toBe("My Epic");
		expect(result.childWorkflowIds).toEqual(["a", "b"]);
	});
});
