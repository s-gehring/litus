import { describe, expect, test } from "bun:test";
import { computeEpicAggregatedState } from "../src/client/epic-aggregation";
import type { EpicAggregatedState } from "../src/types";
import { makeWorkflowState } from "./helpers";

function mustGet(result: EpicAggregatedState | null): EpicAggregatedState {
	if (!result) throw new Error("Expected non-null result");
	return result;
}

const EPIC_DEFAULTS = {
	epicId: "epic-1",
	epicTitle: "Test Epic",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
} as const;

describe("computeEpicAggregatedState", () => {
	test("returns null for empty children", () => {
		expect(computeEpicAggregatedState([])).toBeNull();
	});

	test("returns null if no epicId", () => {
		const child = makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", epicId: null, epicTitle: null });
		expect(computeEpicAggregatedState([child])).toBeNull();
	});

	test("single idle child -> idle status", () => {
		const child = makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", status: "idle" });
		const result = computeEpicAggregatedState([child]);
		expect(result).not.toBeNull();
		expect(result?.status).toBe("idle");
		expect(result?.progress).toEqual({ completed: 0, total: 1 });
	});

	test("running takes priority over everything", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", status: "running" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", status: "error" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "c", status: "completed" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("running");
	});

	test("error takes priority over waiting", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", status: "error" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", status: "waiting_for_input" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("error");
	});

	test("waiting takes priority over in_progress", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", status: "waiting_for_input" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", status: "waiting_for_dependencies" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("waiting");
	});

	test("waiting_for_dependencies -> in_progress", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", status: "completed" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", status: "waiting_for_dependencies" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("in_progress");
	});

	test("all completed -> completed", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", status: "completed" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", status: "completed" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "c", status: "completed" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("completed");
		expect(result.progress).toEqual({ completed: 3, total: 3 });
	});

	test("mixed idle and completed -> idle", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", status: "idle" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", status: "completed" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("idle");
		expect(result.progress).toEqual({ completed: 1, total: 2 });
	});

	test("paused takes priority over waiting and idle", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", status: "paused" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", status: "idle" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("paused");
	});

	test("running takes priority over paused", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", status: "running" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", status: "paused" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("running");
	});

	test("error takes priority over paused", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", status: "error" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", status: "paused" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("error");
	});

	test("all children paused -> paused", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", status: "paused" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", status: "paused" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("paused");
	});

	test("cancelled counts as error", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", status: "cancelled" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", status: "completed" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.status).toBe("error");
	});

	test("start date is min of all createdAt", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", createdAt: "2026-01-03T00:00:00Z" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", createdAt: "2026-01-01T00:00:00Z" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "c", createdAt: "2026-01-02T00:00:00Z" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.startDate).toBe("2026-01-01T00:00:00Z");
	});

	test("preserves epic metadata", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", epicId: "epic-42", epicTitle: "My Epic" }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", epicId: "epic-42", epicTitle: "My Epic" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.epicId).toBe("epic-42");
		expect(result.title).toBe("My Epic");
		expect(result.childWorkflowIds).toEqual(["a", "b"]);
	});

	test("sums active work time across children", () => {
		const children = [
			makeWorkflowState({
				...EPIC_DEFAULTS,
				id: "a",
				activeWorkMs: 5000,
				activeWorkStartedAt: null,
			}),
			makeWorkflowState({
				...EPIC_DEFAULTS,
				id: "b",
				activeWorkMs: 3000,
				activeWorkStartedAt: "2026-01-01T00:10:00Z",
			}),
			makeWorkflowState({
				...EPIC_DEFAULTS,
				id: "c",
				activeWorkMs: 0,
				activeWorkStartedAt: "2026-01-01T00:05:00Z",
			}),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.activeWorkMs).toBe(8000);
		expect(result.activeWorkStartedAt).toBe("2026-01-01T00:05:00Z");
	});

	test("activeWorkStartedAt is null when no children are running", () => {
		const children = [
			makeWorkflowState({
				...EPIC_DEFAULTS,
				id: "a",
				activeWorkMs: 5000,
				activeWorkStartedAt: null,
			}),
			makeWorkflowState({
				...EPIC_DEFAULTS,
				id: "b",
				activeWorkMs: 3000,
				activeWorkStartedAt: null,
			}),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.activeWorkMs).toBe(8000);
		expect(result.activeWorkStartedAt).toBeNull();
	});

	test("finds epicTitle from non-first child when first child has null title", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", epicTitle: null }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", epicTitle: "Found Title" }),
		];
		const result = mustGet(computeEpicAggregatedState(children));
		expect(result.title).toBe("Found Title");
	});

	test("returns null when all children lack epicTitle", () => {
		const children = [
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "a", epicTitle: null }),
			makeWorkflowState({ ...EPIC_DEFAULTS, id: "b", epicTitle: null }),
		];
		expect(computeEpicAggregatedState(children)).toBeNull();
	});
});
