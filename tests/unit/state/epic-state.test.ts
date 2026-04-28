import { describe, expect, test } from "bun:test";
import * as epicState from "../../../src/client/state/epic-state";
import type { EpicFeedbackEntry } from "../../../src/types";
import { makeWorkflowState } from "../../helpers";
import { makePersistedEpic } from "../../test-infra/factories";

describe("epic-state reduce", () => {
	test("epic:list inserts new epics and updates existing fields", () => {
		const state = epicState.createState();
		const e1 = makePersistedEpic({ epicId: "epic-1", title: "First" });
		const e2 = makePersistedEpic({ epicId: "epic-2", title: "Second" });
		const r = epicState.reduce(state, { type: "epic:list", epics: [e1, e2] });
		expect(state.epics.size).toBe(2);
		expect(r.change).toEqual({ notify: true, affectsCardOrder: true });

		// Re-list with updated title overwrites
		const e1Updated = makePersistedEpic({
			epicId: "epic-1",
			title: "Updated",
			workflowIds: ["wf-1"],
		});
		epicState.reduce(state, { type: "epic:list", epics: [e1Updated] });
		expect(state.epics.get("epic-1")?.title).toBe("Updated");
		expect(state.epics.get("epic-1")?.workflowIds).toEqual(["wf-1"]);
		// epic-2 untouched
		expect(state.epics.get("epic-2")?.title).toBe("Second");
	});

	test("epic:created adds an epic with affectsCardOrder=true", () => {
		const state = epicState.createState();
		const r = epicState.reduce(state, {
			type: "epic:created",
			epicId: "new-epic",
			description: "new",
		});
		expect(state.epics.has("new-epic")).toBe(true);
		expect(r.change).toEqual({ notify: true, affectsCardOrder: true });
		expect(r.stateChange).toEqual({ scope: { entity: "epic", id: "new-epic" }, action: "added" });
	});

	test("epic:summary updates the title", () => {
		const state = epicState.createState();
		state.epics.set("e1", { ...makePersistedEpic({ epicId: "e1" }), outputLines: [] });
		const r = epicState.reduce(state, { type: "epic:summary", epicId: "e1", summary: "X" });
		expect(state.epics.get("e1")?.title).toBe("X");
		expect(r.change.notify).toBe(true);
	});

	test("epic:summary unknown id emits warning", () => {
		const state = epicState.createState();
		const r = epicState.reduce(state, { type: "epic:summary", epicId: "ghost", summary: "x" });
		expect(r.warnings?.[0]).toContain("epic:summary");
		expect(r.change.notify).toBe(false);
	});

	test("epic:output appends and trims past max", () => {
		const state = epicState.createState(2);
		state.epics.set("e1", { ...makePersistedEpic({ epicId: "e1" }), outputLines: [] });
		epicState.reduce(state, { type: "epic:output", epicId: "e1", text: "a" });
		epicState.reduce(state, { type: "epic:output", epicId: "e1", text: "b" });
		const r = epicState.reduce(state, { type: "epic:output", epicId: "e1", text: "c" });
		expect(state.epics.get("e1")?.outputLines.length).toBe(2);
		expect(r.stateChange).toEqual({ scope: { entity: "output", id: "e1" }, action: "appended" });
	});

	test("epic:output unknown id emits warning", () => {
		const state = epicState.createState();
		const r = epicState.reduce(state, { type: "epic:output", epicId: "ghost", text: "x" });
		expect(r.warnings?.[0]).toContain("epic:output");
	});

	test("epic:tools appends a tools entry", () => {
		const state = epicState.createState();
		state.epics.set("e1", { ...makePersistedEpic({ epicId: "e1" }), outputLines: [] });
		const r = epicState.reduce(state, { type: "epic:tools", epicId: "e1", tools: [] });
		expect(state.epics.get("e1")?.outputLines.at(-1)).toEqual({ kind: "tools", tools: [] });
		expect(r.change.notify).toBe(true);
	});

	test("epic:tools unknown id emits warning", () => {
		const state = epicState.createState();
		const r = epicState.reduce(state, { type: "epic:tools", epicId: "ghost", tools: [] });
		expect(r.warnings?.[0]).toContain("epic:tools");
	});

	test("epic:result marks completed and triggers card-order rebuild", () => {
		const state = epicState.createState();
		state.epics.set("e1", { ...makePersistedEpic({ epicId: "e1" }), outputLines: [] });
		const r = epicState.reduce(state, {
			type: "epic:result",
			epicId: "e1",
			title: "Done",
			specCount: 2,
			workflowIds: ["wf-1", "wf-2"],
			summary: "summary",
		});
		expect(state.epics.get("e1")?.status).toBe("completed");
		expect(state.epics.get("e1")?.workflowIds).toEqual(["wf-1", "wf-2"]);
		expect(r.change).toEqual({ notify: true, affectsCardOrder: true });
	});

	test("epic:result unknown id emits warning", () => {
		const state = epicState.createState();
		const r = epicState.reduce(state, {
			type: "epic:result",
			epicId: "ghost",
			title: "x",
			specCount: 0,
			workflowIds: [],
			summary: null,
		});
		expect(r.warnings?.[0]).toContain("epic:result");
	});

	test("epic:infeasible marks status and notes", () => {
		const state = epicState.createState();
		state.epics.set("e1", { ...makePersistedEpic({ epicId: "e1" }), outputLines: [] });
		const r = epicState.reduce(state, {
			type: "epic:infeasible",
			epicId: "e1",
			title: "T",
			infeasibleNotes: "reason",
		});
		expect(state.epics.get("e1")?.status).toBe("infeasible");
		expect(state.epics.get("e1")?.infeasibleNotes).toBe("reason");
		expect(r.change.notify).toBe(true);
	});

	test("epic:infeasible unknown id emits warning", () => {
		const state = epicState.createState();
		const r = epicState.reduce(state, {
			type: "epic:infeasible",
			epicId: "ghost",
			title: "T",
			infeasibleNotes: "reason",
		});
		expect(r.warnings?.[0]).toContain("epic:infeasible");
	});

	test("epic:error marks status, message, appends error line", () => {
		const state = epicState.createState();
		state.epics.set("e1", { ...makePersistedEpic({ epicId: "e1" }), outputLines: [] });
		const r = epicState.reduce(state, { type: "epic:error", epicId: "e1", message: "boom" });
		expect(state.epics.get("e1")?.status).toBe("error");
		expect(state.epics.get("e1")?.errorMessage).toBe("boom");
		expect((state.epics.get("e1")?.outputLines[0] as { text: string }).text).toContain("boom");
		expect(r.change.notify).toBe(true);
	});

	test("epic:error unknown id emits warning", () => {
		const state = epicState.createState();
		const r = epicState.reduce(state, { type: "epic:error", epicId: "ghost", message: "boom" });
		expect(r.warnings?.[0]).toContain("epic:error");
	});

	test("epic:feedback:accepted appends a unique entry, increments attemptCount, resets timer + workflowIds", () => {
		const state = epicState.createState();
		state.epics.set("e1", { ...makePersistedEpic({ epicId: "e1" }), outputLines: [] });
		const entry: EpicFeedbackEntry = {
			id: "fb-1",
			text: "x",
			submittedAt: new Date().toISOString(),
			attemptSessionId: null,
			contextLostOnThisAttempt: false,
			outcome: null,
		};
		const r = epicState.reduce(state, {
			type: "epic:feedback:accepted",
			epicId: "e1",
			entry,
		});
		const epic = state.epics.get("e1");
		expect(epic?.feedbackHistory.length).toBe(1);
		expect(epic?.status).toBe("analyzing");
		expect(epic?.completedAt).toBeNull();
		expect(epic?.workflowIds).toEqual([]);
		expect(r.change).toEqual({ notify: true, affectsCardOrder: true });

		// Duplicate entry id is deduped
		epicState.reduce(state, { type: "epic:feedback:accepted", epicId: "e1", entry });
		expect(state.epics.get("e1")?.feedbackHistory.length).toBe(1);
	});

	test("epic:feedback:accepted unknown id emits warning", () => {
		const state = epicState.createState();
		const r = epicState.reduce(state, {
			type: "epic:feedback:accepted",
			epicId: "ghost",
			entry: {
				id: "fb",
				text: "x",
				submittedAt: new Date().toISOString(),
				attemptSessionId: null,
				contextLostOnThisAttempt: false,
				outcome: null,
			},
		});
		expect(r.warnings?.[0]).toContain("epic:feedback:accepted");
	});

	test("epic:feedback:rejected updates scope only", () => {
		const state = epicState.createState();
		const r = epicState.reduce(state, {
			type: "epic:feedback:rejected",
			epicId: "e1",
			reasonCode: "in_flight",
			reason: "x",
		});
		expect(r.stateChange).toEqual({ scope: { entity: "epic", id: "e1" }, action: "updated" });
	});

	test("epic:feedback:history sets entries and sessionContextLost", () => {
		const state = epicState.createState();
		state.epics.set("e1", { ...makePersistedEpic({ epicId: "e1" }), outputLines: [] });
		const entries: EpicFeedbackEntry[] = [
			{
				id: "fb-1",
				text: "x",
				submittedAt: new Date().toISOString(),
				attemptSessionId: null,
				contextLostOnThisAttempt: false,
				outcome: null,
			},
		];
		const r = epicState.reduce(state, {
			type: "epic:feedback:history",
			epicId: "e1",
			entries,
			sessionContextLost: true,
		});
		expect(state.epics.get("e1")?.feedbackHistory).toEqual(entries);
		expect(state.epics.get("e1")?.sessionContextLost).toBe(true);
		expect(r.change.notify).toBe(true);
	});

	test("epic:feedback:history unknown id emits warning", () => {
		const state = epicState.createState();
		const r = epicState.reduce(state, {
			type: "epic:feedback:history",
			epicId: "ghost",
			entries: [],
			sessionContextLost: false,
		});
		expect(r.warnings?.[0]).toContain("epic:feedback:history");
	});

	test("epic:start-first-level:result is a scope-only update", () => {
		const state = epicState.createState();
		const r = epicState.reduce(state, {
			type: "epic:start-first-level:result",
			epicId: "e1",
			started: [],
			skipped: [],
			failed: [],
		});
		expect(r.stateChange).toEqual({ scope: { entity: "epic", id: "e1" }, action: "updated" });
	});
});

describe("epic-state mutators", () => {
	test("setExpandedEpic sets and clears expandedEpicId", () => {
		const state = epicState.createState();
		epicState.setExpandedEpic(state, "e1");
		expect(state.expandedEpicId).toBe("e1");
		epicState.setExpandedEpic(state, null);
		expect(state.expandedEpicId).toBeNull();
	});

	test("reset clears epics, aggregates, expanded id", () => {
		const state = epicState.createState();
		state.epics.set("e1", { ...makePersistedEpic({ epicId: "e1" }), outputLines: [] });
		epicState.setExpandedEpic(state, "e1");
		const r = epicState.reset(state);
		expect(state.epics.size).toBe(0);
		expect(state.epicAggregates.size).toBe(0);
		expect(state.expandedEpicId).toBeNull();
		expect(r.stateChange.action).toBe("cleared");
	});
});

describe("epic-state recomputeAggregates", () => {
	test("rebuilds epicAggregates from a workflows map", () => {
		const state = epicState.createState();
		state.epics.set("e1", { ...makePersistedEpic({ epicId: "e1" }), outputLines: [] });
		const child1 = makeWorkflowState({
			id: "c1",
			epicId: "e1",
			epicTitle: "E1",
			status: "completed",
			createdAt: "2026-01-01T00:00:00Z",
		});
		const child2 = makeWorkflowState({
			id: "c2",
			epicId: "e1",
			epicTitle: "E1",
			status: "running",
			createdAt: "2026-01-02T00:00:00Z",
		});
		const workflows = new Map([
			["c1", { state: child1, outputLines: [] }],
			["c2", { state: child2, outputLines: [] }],
		]);
		epicState.recomputeAggregates(state, workflows);
		const agg = state.epicAggregates.get("e1");
		expect(agg).toBeDefined();
		expect(agg?.progress.total).toBe(2);
		expect(agg?.progress.completed).toBe(1);
	});

	test("clears expandedEpicId when the underlying epic is no longer present", () => {
		const state = epicState.createState();
		state.expandedEpicId = "e-removed";
		epicState.recomputeAggregates(state, new Map());
		expect(state.expandedEpicId).toBeNull();
	});
});
