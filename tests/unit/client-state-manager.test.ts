import { describe, expect, test } from "bun:test";
import { ClientStateManager } from "../../src/client/client-state-manager";
import type {
	EpicDependencyStatus,
	PersistedEpic,
	ServerMessage,
	StateChange,
} from "../../src/types";
import { makeWorkflowState } from "../helpers";
import { makeAppConfig, makePersistedEpic } from "../test-infra/factories";

function createManager(): ClientStateManager {
	return new ClientStateManager();
}

// T004: workflow:list handling
describe("workflow:list", () => {
	test("clears existing workflows and repopulates from message", () => {
		const mgr = createManager();

		// Add an initial workflow
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "old-wf" }),
		});
		expect(mgr.getWorkflows().size).toBe(1);

		// workflow:list replaces everything
		const wf1 = makeWorkflowState({ id: "wf-1" });
		const wf2 = makeWorkflowState({ id: "wf-2" });
		const change = mgr.handleMessage({
			type: "workflow:list",
			workflows: [wf1, wf2],
		});

		expect(mgr.getWorkflows().size).toBe(2);
		expect(mgr.getWorkflows().has("old-wf")).toBe(false);
		expect(mgr.getWorkflows().has("wf-1")).toBe(true);
		expect(mgr.getWorkflows().has("wf-2")).toBe(true);
		expect(change.scope).toEqual({ entity: "global" });
		expect(change.action).toBe("updated");
	});

	test("rebuilds card order after workflow:list", () => {
		const mgr = createManager();
		const wf1 = makeWorkflowState({ id: "wf-a", createdAt: "2026-01-02T00:00:00Z" });
		const wf2 = makeWorkflowState({ id: "wf-b", createdAt: "2026-01-01T00:00:00Z" });
		mgr.handleMessage({ type: "workflow:list", workflows: [wf1, wf2] });

		// Card order should be sorted by date ascending
		expect(mgr.getCardOrder()).toEqual(["wf-b", "wf-a"]);
	});

	test("rebuilds epic aggregates for epic children", () => {
		const mgr = createManager();
		const child1 = makeWorkflowState({
			id: "child-1",
			epicId: "epic-1",
			epicTitle: "My Epic",
			status: "completed",
			createdAt: "2026-01-01T00:00:00Z",
		});
		const child2 = makeWorkflowState({
			id: "child-2",
			epicId: "epic-1",
			epicTitle: "My Epic",
			status: "running",
			createdAt: "2026-01-02T00:00:00Z",
		});
		mgr.handleMessage({ type: "workflow:list", workflows: [child1, child2] });

		expect(mgr.getEpicAggregates().size).toBe(1);
		const agg = mgr.getEpicAggregates().get("epic-1");
		expect(agg).toBeDefined();
		expect(agg?.progress.completed).toBe(1);
		expect(agg?.progress.total).toBe(2);
	});
});

// T005: workflow:created handling
describe("workflow:created", () => {
	test("adds a new workflow to state", () => {
		const mgr = createManager();
		const wf = makeWorkflowState({ id: "new-wf" });
		const change = mgr.handleMessage({ type: "workflow:created", workflow: wf });

		expect(mgr.getWorkflows().size).toBe(1);
		expect(mgr.getWorkflows().get("new-wf")?.state.id).toBe("new-wf");
		expect(change.scope).toEqual({ entity: "workflow", id: "new-wf" });
		expect(change.action).toBe("added");
	});

	test("adds workflow to card order", () => {
		const mgr = createManager();
		const wf = makeWorkflowState({ id: "wf-1" });
		mgr.handleMessage({ type: "workflow:created", workflow: wf });

		expect(mgr.getCardOrder()).toContain("wf-1");
	});

	test("rebuilds card order for epic children", () => {
		const mgr = createManager();
		const child = makeWorkflowState({
			id: "child-1",
			epicId: "epic-1",
			epicTitle: "Epic",
			createdAt: "2026-01-01T00:00:00Z",
		});
		mgr.handleMessage({ type: "workflow:created", workflow: child });

		// Should have epic card prefix in card order
		expect(mgr.getCardOrder()).toContain("epic:epic-1");
		expect(mgr.getEpicAggregates().has("epic-1")).toBe(true);
	});
});

// T006: workflow:state handling
describe("workflow:state", () => {
	test("updates existing workflow state", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1", status: "idle" }),
		});

		const updated = makeWorkflowState({ id: "wf-1", status: "running" });
		const change = mgr.handleMessage({ type: "workflow:state", workflow: updated });

		expect(mgr.getWorkflows().get("wf-1")?.state.status).toBe("running");
		expect(change.scope).toEqual({ entity: "workflow", id: "wf-1" });
		expect(change.action).toBe("updated");
	});

	test("returns none for null workflow", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({ type: "workflow:state", workflow: null });

		expect(change.scope).toEqual({ entity: "none" });
	});

	test("rebuilds epic aggregates for epic children", () => {
		const mgr = createManager();
		const child = makeWorkflowState({
			id: "child-1",
			epicId: "epic-1",
			epicTitle: "Epic",
			status: "idle",
		});
		mgr.handleMessage({ type: "workflow:created", workflow: child });

		const updatedChild = makeWorkflowState({
			id: "child-1",
			epicId: "epic-1",
			epicTitle: "Epic",
			status: "completed",
		});
		mgr.handleMessage({ type: "workflow:state", workflow: updatedChild });

		const agg = mgr.getEpicAggregates().get("epic-1");
		expect(agg).toBeDefined();
		expect(agg?.status).toBe("completed");
	});
});

// T007: workflow:output and workflow:tools handling
describe("workflow:output and workflow:tools", () => {
	test("appends output text to workflow", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		const change = mgr.handleMessage({
			type: "workflow:output",
			workflowId: "wf-1",
			text: "hello",
		});

		const entry = mgr.getWorkflows().get("wf-1");
		expect(entry?.outputLines).toHaveLength(1);
		expect(entry?.outputLines[0]).toEqual({ kind: "text", text: "hello" });
		expect(change.scope).toEqual({ entity: "output", id: "wf-1" });
		expect(change.action).toBe("appended");
	});

	test("appends tool entries to workflow", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		const tools = [{ name: "Read" }];
		const change = mgr.handleMessage({
			type: "workflow:tools",
			workflowId: "wf-1",
			tools,
		});

		const entry = mgr.getWorkflows().get("wf-1");
		expect(entry?.outputLines).toHaveLength(1);
		expect(entry?.outputLines[0]).toEqual({ kind: "tools", tools });
		expect(change.scope).toEqual({ entity: "output", id: "wf-1" });
		expect(change.action).toBe("appended");
	});

	test("trims output at maxOutputLines limit", () => {
		const mgr = createManager();
		// Set a low limit via config:state
		mgr.handleMessage({
			type: "config:state",
			config: makeAppConfig({
				timing: {
					ciGlobalTimeoutMs: 0,
					ciPollIntervalMs: 0,
					activitySummaryIntervalMs: 0,
					rateLimitBackoffMs: 0,
					maxCiLogLength: 0,
					maxClientOutputLines: 3,
					epicTimeoutMs: 0,
				},
			}),
		});

		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		for (let i = 0; i < 5; i++) {
			mgr.handleMessage({
				type: "workflow:output",
				workflowId: "wf-1",
				text: `line ${i}`,
			});
		}

		const entry = mgr.getWorkflows().get("wf-1");
		expect(entry?.outputLines).toHaveLength(3);
		// Oldest lines should be trimmed
		expect((entry?.outputLines[0] as { text: string }).text).toBe("line 2");
	});

	test("returns none for unknown workflow ID", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "workflow:output",
			workflowId: "nonexistent",
			text: "hello",
		});
		expect(change.scope).toEqual({ entity: "none" });
	});

	test("workflow:tools returns none for unknown workflow ID", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "workflow:tools",
			workflowId: "nonexistent",
			tools: [{ name: "Read" }],
		});
		expect(change.scope).toEqual({ entity: "none" });
	});
});

// T008: workflow:question and workflow:step-change handling
describe("workflow:question and workflow:step-change", () => {
	test("sets pendingQuestion on workflow", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		const question = { id: "q-1", content: "What repo?", detectedAt: new Date().toISOString() };
		const change = mgr.handleMessage({
			type: "workflow:question",
			workflowId: "wf-1",
			question,
		});

		expect(mgr.getWorkflows().get("wf-1")?.state.pendingQuestion).toEqual(question);
		expect(change.scope).toEqual({ entity: "workflow", id: "wf-1" });
		expect(change.action).toBe("updated");
	});

	test("workflow:question returns none for unknown workflow", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "workflow:question",
			workflowId: "nonexistent",
			question: { id: "q-1", content: "?", detectedAt: new Date().toISOString() },
		});
		expect(change.scope).toEqual({ entity: "none" });
	});

	test("updates currentStepIndex and reviewCycle on step-change", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		const change = mgr.handleMessage({
			type: "workflow:step-change",
			workflowId: "wf-1",
			previousStep: "specify",
			currentStep: "plan",
			currentStepIndex: 3,
			reviewIteration: 2,
		});

		const entry = mgr.getWorkflows().get("wf-1");
		expect(entry?.state.currentStepIndex).toBe(3);
		expect(entry?.state.reviewCycle.iteration).toBe(2);
		expect(change.scope).toEqual({ entity: "workflow", id: "wf-1" });
		expect(change.action).toBe("updated");
	});

	test("resets output to step marker on step-change", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		// Add some output first
		mgr.handleMessage({ type: "workflow:output", workflowId: "wf-1", text: "old output" });

		mgr.handleMessage({
			type: "workflow:step-change",
			workflowId: "wf-1",
			previousStep: null,
			currentStep: "implement",
			currentStepIndex: 5,
			reviewIteration: 1,
		});

		const entry = mgr.getWorkflows().get("wf-1");
		expect(entry?.outputLines).toHaveLength(1);
		expect((entry?.outputLines[0] as { text: string }).text).toContain("Step: implement");
	});

	test("workflow:step-change returns none for unknown workflow", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "workflow:step-change",
			workflowId: "nonexistent",
			previousStep: null,
			currentStep: "plan",
			currentStepIndex: 0,
			reviewIteration: 1,
		});
		expect(change.scope).toEqual({ entity: "none" });
	});
});

// T009: epic:list, epic:created, epic:summary, epic:output, epic:tools handling
describe("epic:list, epic:created, epic:summary, epic:output, epic:tools", () => {
	test("epic:list adds new epics and rebuilds card order", () => {
		const mgr = createManager();
		const epics: PersistedEpic[] = [
			makePersistedEpic({ epicId: "e-1", workflowIds: [] }),
			makePersistedEpic({ epicId: "e-2", workflowIds: [] }),
		];
		const change = mgr.handleMessage({ type: "epic:list", epics });

		expect(mgr.getEpics().size).toBe(2);
		expect(change.scope).toEqual({ entity: "global" });
		expect(change.action).toBe("updated");
	});

	test("epic:list does not overwrite existing epics", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "epic:created",
			epicId: "e-1",
			description: "original",
		});

		mgr.handleMessage({
			type: "epic:list",
			epics: [makePersistedEpic({ epicId: "e-1", description: "from list" })],
		});

		// Should keep the original since it already existed
		expect(mgr.getEpics().get("e-1")?.description).toBe("original");
	});

	test("epic:list adds childless epics to card order", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "epic:list",
			epics: [makePersistedEpic({ epicId: "e-1", workflowIds: [] })],
		});

		expect(mgr.getCardOrder()).toContain("e-1");
	});

	test("epic:created adds new epic with analyzing status", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "epic:created",
			epicId: "e-1",
			description: "Build something",
		});

		const epic = mgr.getEpics().get("e-1");
		expect(epic).toBeDefined();
		expect(epic?.status).toBe("analyzing");
		expect(epic?.description).toBe("Build something");
		expect(change.scope).toEqual({ entity: "epic", id: "e-1" });
		expect(change.action).toBe("added");
	});

	test("epic:created adds epic to card order", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "epic:created",
			epicId: "e-1",
			description: "test",
		});
		expect(mgr.getCardOrder()).toContain("e-1");
	});

	test("epic:summary updates epic title", () => {
		const mgr = createManager();
		mgr.handleMessage({ type: "epic:created", epicId: "e-1", description: "test" });

		const change = mgr.handleMessage({
			type: "epic:summary",
			epicId: "e-1",
			summary: "New Title",
		});

		expect(mgr.getEpics().get("e-1")?.title).toBe("New Title");
		expect(change.scope).toEqual({ entity: "epic", id: "e-1" });
		expect(change.action).toBe("updated");
	});

	test("epic:summary returns none for unknown epic", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "epic:summary",
			epicId: "nonexistent",
			summary: "Title",
		});
		expect(change.scope).toEqual({ entity: "none" });
	});

	test("epic:output appends output to epic", () => {
		const mgr = createManager();
		mgr.handleMessage({ type: "epic:created", epicId: "e-1", description: "test" });

		const change = mgr.handleMessage({
			type: "epic:output",
			epicId: "e-1",
			text: "hello",
		});

		expect(mgr.getEpics().get("e-1")?.outputLines).toHaveLength(1);
		expect(change.scope).toEqual({ entity: "output", id: "e-1" });
		expect(change.action).toBe("appended");
	});

	test("epic:output returns none for unknown epic", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "epic:output",
			epicId: "nonexistent",
			text: "hello",
		});
		expect(change.scope).toEqual({ entity: "none" });
	});

	test("epic:tools appends tool entry to epic", () => {
		const mgr = createManager();
		mgr.handleMessage({ type: "epic:created", epicId: "e-1", description: "test" });

		const tools = [{ name: "Write" }];
		const change = mgr.handleMessage({
			type: "epic:tools",
			epicId: "e-1",
			tools,
		});

		const epic = mgr.getEpics().get("e-1");
		expect(epic?.outputLines).toHaveLength(1);
		expect(epic?.outputLines[0]).toEqual({ kind: "tools", tools });
		expect(change.scope).toEqual({ entity: "output", id: "e-1" });
		expect(change.action).toBe("appended");
	});

	test("epic:tools returns none for unknown epic", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "epic:tools",
			epicId: "nonexistent",
			tools: [{ name: "Read" }],
		});
		expect(change.scope).toEqual({ entity: "none" });
	});
});

// T010: epic:result, epic:infeasible, epic:error, epic:dependency-update handling
describe("epic:result, epic:infeasible, epic:error, epic:dependency-update", () => {
	test("epic:result updates epic status and workflowIds", () => {
		const mgr = createManager();
		mgr.handleMessage({ type: "epic:created", epicId: "e-1", description: "test" });

		const change = mgr.handleMessage({
			type: "epic:result",
			epicId: "e-1",
			title: "Completed Epic",
			specCount: 3,
			workflowIds: ["wf-1", "wf-2"],
			summary: "All done",
		});

		const epic = mgr.getEpics().get("e-1");
		expect(epic?.status).toBe("completed");
		expect(epic?.title).toBe("Completed Epic");
		expect(epic?.workflowIds).toEqual(["wf-1", "wf-2"]);
		expect(epic?.analysisSummary).toBe("All done");
		expect(change.scope).toEqual({ entity: "epic", id: "e-1" });
		expect(change.action).toBe("updated");
	});

	test("epic:result returns none for unknown epic", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "epic:result",
			epicId: "nonexistent",
			title: "T",
			specCount: 0,
			workflowIds: [],
			summary: null,
		});
		expect(change.scope).toEqual({ entity: "none" });
	});

	test("epic:infeasible sets infeasible status and notes", () => {
		const mgr = createManager();
		mgr.handleMessage({ type: "epic:created", epicId: "e-1", description: "test" });

		const change = mgr.handleMessage({
			type: "epic:infeasible",
			epicId: "e-1",
			title: "Infeasible",
			infeasibleNotes: "Cannot do this",
		});

		const epic = mgr.getEpics().get("e-1");
		expect(epic?.status).toBe("infeasible");
		expect(epic?.infeasibleNotes).toBe("Cannot do this");
		expect(change.scope).toEqual({ entity: "epic", id: "e-1" });
	});

	test("epic:infeasible returns none for unknown epic", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "epic:infeasible",
			epicId: "nonexistent",
			title: "T",
			infeasibleNotes: "N",
		});
		expect(change.scope).toEqual({ entity: "none" });
	});

	test("epic:error sets error status and appends error output", () => {
		const mgr = createManager();
		mgr.handleMessage({ type: "epic:created", epicId: "e-1", description: "test" });

		const change = mgr.handleMessage({
			type: "epic:error",
			epicId: "e-1",
			message: "Something went wrong",
		});

		const epic = mgr.getEpics().get("e-1");
		expect(epic?.status).toBe("error");
		expect(epic?.errorMessage).toBe("Something went wrong");
		expect(epic?.outputLines).toHaveLength(1);
		expect((epic?.outputLines[0] as { text: string }).text).toContain("Something went wrong");
		expect(change.scope).toEqual({ entity: "epic", id: "e-1" });
	});

	test("epic:error returns none for unknown epic", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "epic:error",
			epicId: "nonexistent",
			message: "err",
		});
		expect(change.scope).toEqual({ entity: "none" });
	});

	test("epic:dependency-update updates workflow epicDependencyStatus", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1", epicId: "e-1" }),
		});

		const change = mgr.handleMessage({
			type: "epic:dependency-update",
			workflowId: "wf-1",
			epicDependencyStatus: "satisfied" as EpicDependencyStatus,
			blockingWorkflows: [],
		});

		expect(mgr.getWorkflows().get("wf-1")?.state.epicDependencyStatus).toBe("satisfied");
		expect(change.scope).toEqual({ entity: "workflow", id: "wf-1" });
		expect(change.action).toBe("updated");
	});

	test("epic:dependency-update returns none for unknown workflow", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "epic:dependency-update",
			workflowId: "nonexistent",
			epicDependencyStatus: "waiting",
			blockingWorkflows: [],
		});
		expect(change.scope).toEqual({ entity: "none" });
	});
});

// T011: purge:progress and purge:complete handling
describe("purge:progress and purge:complete", () => {
	test("purge:progress returns none scope (view-only)", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "purge:progress",
			step: "workflows",
			current: 1,
			total: 3,
		});
		expect(change.scope).toEqual({ entity: "none" });
		expect(change.action).toBe("updated");
	});

	test("purge:complete clears all state", () => {
		const mgr = createManager();
		// Populate state
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		mgr.handleMessage({ type: "epic:created", epicId: "e-1", description: "test" });
		mgr.expandItem("wf-1");

		const change = mgr.handleMessage({
			type: "purge:complete",
			warnings: [],
		});

		expect(mgr.getWorkflows().size).toBe(0);
		expect(mgr.getEpics().size).toBe(0);
		expect(mgr.getEpicAggregates().size).toBe(0);
		expect(mgr.getCardOrder()).toHaveLength(0);
		expect(mgr.getExpandedId()).toBeNull();
		expect(mgr.getExpandedEpicId()).toBeNull();
		expect(mgr.getSelectedChildId()).toBeNull();
		expect(mgr.getSelectedStepIndex()).toBeNull();
		expect(change.scope).toEqual({ entity: "global" });
		expect(change.action).toBe("cleared");
	});
});

// T012: config:state, config:error, log, error, unknown message types
describe("config:state, config:error, log, error, and unknown messages", () => {
	test("config:state updates maxOutputLines", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "config:state",
			config: makeAppConfig({
				timing: {
					ciGlobalTimeoutMs: 0,
					ciPollIntervalMs: 0,
					activitySummaryIntervalMs: 0,
					rateLimitBackoffMs: 0,
					maxCiLogLength: 0,
					maxClientOutputLines: 100,
					epicTimeoutMs: 0,
				},
			}),
		});
		expect(change.scope).toEqual({ entity: "config" });
		expect(change.action).toBe("updated");

		// Verify the limit is applied: add a workflow with output
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		for (let i = 0; i < 110; i++) {
			mgr.handleMessage({ type: "workflow:output", workflowId: "wf-1", text: `line ${i}` });
		}
		expect(mgr.getWorkflows().get("wf-1")?.outputLines).toHaveLength(100);
	});

	test("config:state accepts maxClientOutputLines of 0", () => {
		const mgr = createManager();
		// First set a non-zero value
		mgr.handleMessage({
			type: "config:state",
			config: makeAppConfig({
				timing: {
					ciGlobalTimeoutMs: 0,
					ciPollIntervalMs: 0,
					activitySummaryIntervalMs: 0,
					rateLimitBackoffMs: 0,
					maxCiLogLength: 0,
					maxClientOutputLines: 100,
					epicTimeoutMs: 0,
				},
			}),
		});

		// Now set to 0 — should be accepted, not skipped
		mgr.handleMessage({
			type: "config:state",
			config: makeAppConfig({
				timing: {
					ciGlobalTimeoutMs: 0,
					ciPollIntervalMs: 0,
					activitySummaryIntervalMs: 0,
					rateLimitBackoffMs: 0,
					maxCiLogLength: 0,
					maxClientOutputLines: 0,
					epicTimeoutMs: 0,
				},
			}),
		});

		// With maxOutputLines=0, adding output should immediately trim to 0
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		mgr.handleMessage({ type: "workflow:output", workflowId: "wf-1", text: "line" });
		expect(mgr.getWorkflows().get("wf-1")?.outputLines).toHaveLength(0);
	});

	test("config:error returns config scope", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "config:error",
			errors: [{ path: "models.foo", message: "bad value", value: "" }],
		});
		expect(change.scope).toEqual({ entity: "config" });
		expect(change.action).toBe("updated");
	});

	test("log returns none scope", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({ type: "log", text: "info message" });
		expect(change.scope).toEqual({ entity: "none" });
		expect(change.action).toBe("updated");
	});

	test("error returns none scope", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({ type: "error", message: "something broke" });
		expect(change.scope).toEqual({ entity: "none" });
		expect(change.action).toBe("updated");
	});
});

// T013: selection methods: expandItem toggle, selectChild, selectStep
describe("selection methods", () => {
	test("expandItem toggles expand on regular workflow", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		mgr.expandItem("wf-1");
		expect(mgr.getExpandedId()).toBe("wf-1");

		// Toggle off
		mgr.expandItem("wf-1");
		expect(mgr.getExpandedId()).toBeNull();
	});

	test("expandItem switches between workflows", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-2" }),
		});

		mgr.expandItem("wf-1");
		expect(mgr.getExpandedId()).toBe("wf-1");

		mgr.expandItem("wf-2");
		expect(mgr.getExpandedId()).toBe("wf-2");
	});

	test("expandItem handles epic card prefix", () => {
		const mgr = createManager();

		mgr.expandItem("epic:e-1");
		expect(mgr.getExpandedEpicId()).toBe("e-1");
		expect(mgr.getExpandedId()).toBe("epic:e-1");

		// Toggle off
		mgr.expandItem("epic:e-1");
		expect(mgr.getExpandedEpicId()).toBeNull();
		expect(mgr.getExpandedId()).toBeNull();
	});

	test("expandItem clears selection state on collapse", () => {
		const mgr = createManager();

		mgr.expandItem("epic:e-1");
		mgr.selectChild("child-1");
		mgr.selectStep(2);

		mgr.expandItem("wf-other");
		expect(mgr.getExpandedEpicId()).toBeNull();
		expect(mgr.getSelectedChildId()).toBeNull();
		expect(mgr.getSelectedStepIndex()).toBeNull();
	});

	test("selectChild toggles child selection", () => {
		const mgr = createManager();

		mgr.selectChild("wf-1");
		expect(mgr.getSelectedChildId()).toBe("wf-1");

		// Toggle off
		mgr.selectChild("wf-1");
		expect(mgr.getSelectedChildId()).toBeNull();
	});

	test("selectChild resets step index", () => {
		const mgr = createManager();

		mgr.selectStep(3);
		mgr.selectChild("wf-1");
		expect(mgr.getSelectedStepIndex()).toBeNull();
	});

	test("selectStep sets step index", () => {
		const mgr = createManager();

		mgr.selectStep(5);
		expect(mgr.getSelectedStepIndex()).toBe(5);
	});
});

// T014: listener notification
describe("listener notification", () => {
	test("fires listener with StateChange and original message", () => {
		const mgr = createManager();
		const received: { change: StateChange; msg: ServerMessage }[] = [];

		mgr.onStateChange((change, msg) => {
			received.push({ change, msg });
		});

		const msg: ServerMessage = {
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		};
		mgr.handleMessage(msg);

		expect(received).toHaveLength(1);
		expect(received[0].change.scope).toEqual({ entity: "workflow", id: "wf-1" });
		expect(received[0].change.action).toBe("added");
		expect(received[0].msg.type).toBe("workflow:created");
	});

	test("does not throw when no listener is registered", () => {
		const mgr = createManager();
		// Should not throw
		expect(() => {
			mgr.handleMessage({
				type: "workflow:created",
				workflow: makeWorkflowState({ id: "wf-1" }),
			});
		}).not.toThrow();
	});

	test("fires exactly once per handleMessage call", () => {
		const mgr = createManager();
		let callCount = 0;
		mgr.onStateChange(() => {
			callCount++;
		});

		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		expect(callCount).toBe(1);

		mgr.handleMessage({
			type: "workflow:output",
			workflowId: "wf-1",
			text: "hello",
		});
		expect(callCount).toBe(2);
	});

	test("listener receives none scope for view-only messages", () => {
		const mgr = createManager();
		const changes: StateChange[] = [];
		mgr.onStateChange((change) => {
			changes.push(change);
		});

		mgr.handleMessage({ type: "log", text: "info" });
		mgr.handleMessage({ type: "error", message: "err" });

		expect(changes).toHaveLength(2);
		expect(changes[0].scope).toEqual({ entity: "none" });
		expect(changes[1].scope).toEqual({ entity: "none" });
	});
});

// T028: getLastTargetRepo
describe("getLastTargetRepo", () => {
	test("returns empty string when no workflows exist", () => {
		const mgr = createManager();
		expect(mgr.getLastTargetRepo()).toBe("");
	});

	test("returns most recently created workflow's targetRepository", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({
				id: "wf-1",
				targetRepository: "/repo/a",
				createdAt: "2026-01-01T00:00:00Z",
			}),
		});
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({
				id: "wf-2",
				targetRepository: "/repo/b",
				createdAt: "2026-01-02T00:00:00Z",
			}),
		});

		expect(mgr.getLastTargetRepo()).toBe("/repo/b");
	});

	test("skips workflows with null targetRepository", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({
				id: "wf-1",
				targetRepository: "/repo/a",
				createdAt: "2026-01-01T00:00:00Z",
			}),
		});
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({
				id: "wf-2",
				targetRepository: null,
				createdAt: "2026-01-02T00:00:00Z",
			}),
		});

		expect(mgr.getLastTargetRepo()).toBe("/repo/a");
	});
});
