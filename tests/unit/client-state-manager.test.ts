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

		// Card order should be sorted by date descending (newest first)
		expect(mgr.getCardOrder()).toEqual(["wf-a", "wf-b"]);
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
					cliIdleTimeoutMs: 0,
					artifactsTimeoutMs: 0,
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

	test("returns none for unknown workflow ID and logs unrouted diagnostic", () => {
		const mgr = createManager();
		const original = console.log;
		const logs: string[] = [];
		console.log = (...args: unknown[]) => {
			logs.push(args.map((a) => String(a)).join(" "));
		};
		try {
			const change = mgr.handleMessage({
				type: "workflow:output",
				workflowId: "nonexistent",
				text: "hello",
			});
			expect(change.scope).toEqual({ entity: "none" });
			expect(logs).toContain("[litus:unrouted workflow=nonexistent] hello");
		} finally {
			console.log = original;
		}
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

// T012: config:state, config:error, console:output, error, unknown message types
describe("config:state, config:error, console:output, error, and unknown messages", () => {
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
					cliIdleTimeoutMs: 0,
					artifactsTimeoutMs: 0,
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
					cliIdleTimeoutMs: 0,
					artifactsTimeoutMs: 0,
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
					cliIdleTimeoutMs: 0,
					artifactsTimeoutMs: 0,
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

	test("epic:output for unknown epic ID logs unrouted diagnostic", () => {
		const mgr = createManager();
		const original = console.log;
		const logs: string[] = [];
		console.log = (...args: unknown[]) => {
			logs.push(args.map((a) => String(a)).join(" "));
		};
		try {
			const change = mgr.handleMessage({
				type: "epic:output",
				epicId: "unknown-epic",
				text: "stray epic output",
			});
			expect(change.scope).toEqual({ entity: "none" });
			expect(logs).toContain("[litus:unrouted epic=unknown-epic] stray epic output");
		} finally {
			console.log = original;
		}
	});

	test("console:output logs with [litus:console] prefix and mutates no UI state", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		mgr.handleMessage({ type: "epic:created", epicId: "ep-1", description: "test" });

		const original = console.log;
		const logs: string[] = [];
		console.log = (...args: unknown[]) => {
			logs.push(args.map((a) => String(a)).join(" "));
		};
		try {
			const change = mgr.handleMessage({ type: "console:output", text: "diagnostic" });
			expect(logs).toContain("[litus:console] diagnostic");
			expect(change.scope).toEqual({ entity: "none" });
			expect(change.action).toBe("updated");
			expect(mgr.getWorkflows().get("wf-1")?.outputLines).toHaveLength(0);
			expect(mgr.getEpics().get("ep-1")?.outputLines).toHaveLength(0);
		} finally {
			console.log = original;
		}
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

	test("selectStepFor binds the selection to a workflow id", () => {
		const mgr = createManager();

		mgr.selectStepFor("wf-a", 3);
		expect(mgr.getSelectedStepIndex()).toBe(3);
		expect(mgr.getSelectedStepIndexFor("wf-a")).toBe(3);
	});

	test("getSelectedStepIndexFor returns null for a different workflow", () => {
		const mgr = createManager();

		mgr.selectStepFor("wf-a", 3);
		expect(mgr.getSelectedStepIndexFor("wf-b")).toBeNull();
	});

	test("selectChild clears the per-workflow binding", () => {
		const mgr = createManager();

		mgr.selectStepFor("wf-a", 4);
		mgr.selectChild("wf-other");
		expect(mgr.getSelectedStepIndexFor("wf-a")).toBeNull();
	});

	test("expandItem clears the per-workflow binding", () => {
		const mgr = createManager();

		mgr.selectStepFor("wf-a", 2);
		mgr.expandItem("wf-a");
		expect(mgr.getSelectedStepIndexFor("wf-a")).toBeNull();
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

		mgr.handleMessage({ type: "console:output", text: "info" });
		mgr.handleMessage({ type: "error", message: "err" });

		expect(changes).toHaveLength(2);
		expect(changes[0].scope).toEqual({ entity: "none" });
		expect(changes[1].scope).toEqual({ entity: "none" });
	});
});

// T001: Edge case — messages targeting non-existent workflow IDs
describe("edge cases: non-existent workflow IDs", () => {
	test("workflow:state with non-existent ID creates the workflow", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "workflow:state",
			workflow: makeWorkflowState({ id: "ghost" }),
		});
		// It creates the workflow (addOrUpdateWorkflow), so it returns updated
		expect(mgr.getWorkflows().has("ghost")).toBe(true);
		expect(change.scope).toEqual({ entity: "workflow", id: "ghost" });
	});

	test("workflow:question for non-existent workflow returns none", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "workflow:question",
			workflowId: "ghost",
			question: { id: "q-1", content: "?", detectedAt: new Date().toISOString() },
		});
		expect(change.scope).toEqual({ entity: "none" });
	});

	test("workflow:step-change for non-existent workflow returns none", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "workflow:step-change",
			workflowId: "ghost",
			previousStep: null,
			currentStep: "implement",
			currentStepIndex: 0,
			reviewIteration: 1,
		});
		expect(change.scope).toEqual({ entity: "none" });
	});

	test("epic:dependency-update for non-existent workflow returns none", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({
			type: "epic:dependency-update",
			workflowId: "ghost",
			epicDependencyStatus: "waiting",
			blockingWorkflows: [],
		});
		expect(change.scope).toEqual({ entity: "none" });
	});
});

// T002: Edge case — workflow:output with empty lines and maxOutputLines boundary
describe("edge cases: output trimming boundaries", () => {
	test("workflow:output with empty string appends empty text entry", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		mgr.handleMessage({ type: "workflow:output", workflowId: "wf-1", text: "" });

		const entry = mgr.getWorkflows().get("wf-1");
		expect(entry?.outputLines).toHaveLength(1);
		expect((entry?.outputLines[0] as { text: string }).text).toBe("");
	});

	test("output at exactly maxOutputLines does not trim", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "config:state",
			config: makeAppConfig({
				timing: {
					ciGlobalTimeoutMs: 0,
					ciPollIntervalMs: 0,
					activitySummaryIntervalMs: 0,
					rateLimitBackoffMs: 0,
					maxCiLogLength: 0,
					maxClientOutputLines: 5,
					epicTimeoutMs: 0,
					cliIdleTimeoutMs: 0,
					artifactsTimeoutMs: 0,
				},
			}),
		});
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		for (let i = 0; i < 5; i++) {
			mgr.handleMessage({ type: "workflow:output", workflowId: "wf-1", text: `line ${i}` });
		}

		const entry = mgr.getWorkflows().get("wf-1");
		expect(entry?.outputLines).toHaveLength(5);
		expect((entry?.outputLines[0] as { text: string }).text).toBe("line 0");
	});

	test("output at maxOutputLines + 1 trims oldest entry", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "config:state",
			config: makeAppConfig({
				timing: {
					ciGlobalTimeoutMs: 0,
					ciPollIntervalMs: 0,
					activitySummaryIntervalMs: 0,
					rateLimitBackoffMs: 0,
					maxCiLogLength: 0,
					maxClientOutputLines: 5,
					epicTimeoutMs: 0,
					cliIdleTimeoutMs: 0,
					artifactsTimeoutMs: 0,
				},
			}),
		});
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		for (let i = 0; i < 6; i++) {
			mgr.handleMessage({ type: "workflow:output", workflowId: "wf-1", text: `line ${i}` });
		}

		const entry = mgr.getWorkflows().get("wf-1");
		expect(entry?.outputLines).toHaveLength(5);
		expect((entry?.outputLines[0] as { text: string }).text).toBe("line 1");
		expect((entry?.outputLines[4] as { text: string }).text).toBe("line 5");
	});
});

// T003: Edge case — workflow:step-change on workflow with no steps, workflow:list with duplicate IDs
describe("edge cases: step-change and duplicate IDs", () => {
	test("workflow:step-change on workflow with no steps resets output", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		const change = mgr.handleMessage({
			type: "workflow:step-change",
			workflowId: "wf-1",
			previousStep: null,
			currentStep: "plan",
			currentStepIndex: 0,
			reviewIteration: 1,
		});

		const entry = mgr.getWorkflows().get("wf-1");
		expect(entry?.outputLines).toHaveLength(1);
		expect((entry?.outputLines[0] as { text: string }).text).toContain("Step: plan");
		expect(change.action).toBe("updated");
	});

	test("workflow:list with duplicate IDs keeps last occurrence", () => {
		const mgr = createManager();
		const wf1a = makeWorkflowState({ id: "wf-1", status: "idle" });
		const wf1b = makeWorkflowState({ id: "wf-1", status: "running" });

		mgr.handleMessage({ type: "workflow:list", workflows: [wf1a, wf1b] });

		// addOrUpdateWorkflow updates in place, so last write wins
		expect(mgr.getWorkflows().size).toBe(1);
		expect(mgr.getWorkflows().get("wf-1")?.state.status).toBe("running");
	});
});

// T004: rebuildCardOrder sort order correctness
describe("rebuildCardOrder sort order", () => {
	test("sorts workflows by createdAt descending", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:list",
			workflows: [
				makeWorkflowState({ id: "wf-c", createdAt: "2026-01-03T00:00:00Z" }),
				makeWorkflowState({ id: "wf-a", createdAt: "2026-01-01T00:00:00Z" }),
				makeWorkflowState({ id: "wf-b", createdAt: "2026-01-02T00:00:00Z" }),
			],
		});

		expect(mgr.getCardOrder()).toEqual(["wf-c", "wf-b", "wf-a"]);
	});

	test("identical sort dates produce stable order", () => {
		const mgr = createManager();
		const sameDate = "2026-01-01T00:00:00Z";
		mgr.handleMessage({
			type: "workflow:list",
			workflows: [
				makeWorkflowState({ id: "wf-x", createdAt: sameDate }),
				makeWorkflowState({ id: "wf-y", createdAt: sameDate }),
				makeWorkflowState({ id: "wf-z", createdAt: sameDate }),
			],
		});

		const order = mgr.getCardOrder();
		expect(order).toHaveLength(3);
		// All three should be present regardless of order
		expect(order).toContain("wf-x");
		expect(order).toContain("wf-y");
		expect(order).toContain("wf-z");
	});

	test("epic cards sorted by aggregate startDate among standalone workflows", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:list",
			workflows: [
				makeWorkflowState({ id: "standalone", createdAt: "2026-01-02T00:00:00Z" }),
				makeWorkflowState({
					id: "child-1",
					epicId: "epic-1",
					epicTitle: "E1",
					createdAt: "2026-01-01T00:00:00Z",
				}),
				makeWorkflowState({
					id: "child-2",
					epicId: "epic-1",
					epicTitle: "E1",
					createdAt: "2026-01-03T00:00:00Z",
				}),
			],
		});

		const order = mgr.getCardOrder();
		// Epic aggregate startDate = min(child createdAt) = 2026-01-01
		// Standalone = 2026-01-02
		// Sorted newest first.
		expect(order).toEqual(["standalone", "epic:epic-1"]);
	});
});

// T005: rebuildEpicAggregates computing correct aggregated state
describe("rebuildEpicAggregates", () => {
	test("computes progress from child workflow statuses", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:list",
			workflows: [
				makeWorkflowState({ id: "c-1", epicId: "e-1", epicTitle: "Epic", status: "completed" }),
				makeWorkflowState({ id: "c-2", epicId: "e-1", epicTitle: "Epic", status: "completed" }),
				makeWorkflowState({ id: "c-3", epicId: "e-1", epicTitle: "Epic", status: "running" }),
			],
		});

		const agg = mgr.getEpicAggregates().get("e-1");
		expect(agg?.progress.completed).toBe(2);
		expect(agg?.progress.total).toBe(3);
		expect(agg?.status).toBe("running");
	});

	test("aggregates activeWorkMs across children", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:list",
			workflows: [
				makeWorkflowState({ id: "c-1", epicId: "e-1", epicTitle: "Epic", activeWorkMs: 1000 }),
				makeWorkflowState({ id: "c-2", epicId: "e-1", epicTitle: "Epic", activeWorkMs: 2000 }),
			],
		});

		const agg = mgr.getEpicAggregates().get("e-1");
		expect(agg?.activeWorkMs).toBeGreaterThanOrEqual(3000);
	});

	test("returns null aggregate for epic with no title on any child", () => {
		const mgr = createManager();
		mgr.handleMessage({
			type: "workflow:list",
			workflows: [makeWorkflowState({ id: "c-1", epicId: "e-1", epicTitle: null })],
		});

		expect(mgr.getEpicAggregates().has("e-1")).toBe(false);
	});
});

// T006: Aggregate sequence test
describe("aggregate sequence: create → output → step-change → state", () => {
	test("final state reflects all mutations in order", () => {
		const mgr = createManager();

		// 1. Create workflow
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-seq", status: "idle" }),
		});
		expect(mgr.getWorkflows().get("wf-seq")?.state.status).toBe("idle");

		// 2. Add output
		mgr.handleMessage({ type: "workflow:output", workflowId: "wf-seq", text: "Starting..." });
		expect(mgr.getWorkflows().get("wf-seq")?.outputLines).toHaveLength(1);

		// 3. Step change (resets output)
		mgr.handleMessage({
			type: "workflow:step-change",
			workflowId: "wf-seq",
			previousStep: null,
			currentStep: "implement",
			currentStepIndex: 2,
			reviewIteration: 1,
		});
		expect(mgr.getWorkflows().get("wf-seq")?.state.currentStepIndex).toBe(2);
		expect(mgr.getWorkflows().get("wf-seq")?.outputLines).toHaveLength(1); // step marker only

		// 4. Update state to running
		mgr.handleMessage({
			type: "workflow:state",
			workflow: makeWorkflowState({ id: "wf-seq", status: "running" }),
		});
		expect(mgr.getWorkflows().get("wf-seq")?.state.status).toBe("running");

		// 5. Add more output after step change
		mgr.handleMessage({ type: "workflow:output", workflowId: "wf-seq", text: "Working..." });
		expect(mgr.getWorkflows().get("wf-seq")?.outputLines).toHaveLength(2); // step marker + new output
	});
});

// T007: purge:complete clears all maps and resets selection
describe("purge:complete edge cases", () => {
	test("purge with epic aggregates clears everything", () => {
		const mgr = createManager();

		// Populate workflows, epics, and epic aggregates
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({
				id: "child-1",
				epicId: "e-1",
				epicTitle: "Epic",
				status: "running",
			}),
		});
		mgr.handleMessage({ type: "epic:created", epicId: "e-1", description: "test" });
		mgr.expandItem("epic:e-1");
		mgr.selectChild("child-1");
		mgr.selectStep(3);

		expect(mgr.getEpicAggregates().size).toBeGreaterThan(0);
		expect(mgr.getSelectedChildId()).toBe("child-1");
		expect(mgr.getSelectedStepIndex()).toBe(3);

		const change = mgr.handleMessage({ type: "purge:complete", warnings: [] });

		expect(mgr.getWorkflows().size).toBe(0);
		expect(mgr.getEpics().size).toBe(0);
		expect(mgr.getEpicAggregates().size).toBe(0);
		expect(mgr.getCardOrder()).toHaveLength(0);
		expect(mgr.getExpandedId()).toBeNull();
		expect(mgr.getExpandedEpicId()).toBeNull();
		expect(mgr.getSelectedChildId()).toBeNull();
		expect(mgr.getSelectedStepIndex()).toBeNull();
		expect(change.action).toBe("cleared");
	});

	test("purge on already-empty state is safe", () => {
		const mgr = createManager();
		const change = mgr.handleMessage({ type: "purge:complete", warnings: [] });
		expect(change.action).toBe("cleared");
		expect(mgr.getWorkflows().size).toBe(0);
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

describe("alert:seen handling", () => {
	function seedAlert(mgr: ClientStateManager, id: string, seen: boolean): void {
		mgr.handleMessage({
			type: "alert:list",
			alerts: [
				{
					id,
					type: "workflow-finished",
					title: "t",
					description: "d",
					workflowId: null,
					epicId: null,
					targetRoute: "/x",
					createdAt: Date.now(),
					seen,
				},
			],
		});
	}

	test("flips a known alert's seen flag to true and returns a global/updated StateChange", () => {
		const mgr = createManager();
		seedAlert(mgr, "a1", false);
		const change = mgr.handleMessage({ type: "alert:seen", alertIds: ["a1"] });
		expect(mgr.getAlerts().get("a1")?.seen).toBe(true);
		expect(change).toEqual({ scope: { entity: "global" }, action: "updated" });
	});

	test("unknown id is a no-op (future-proof per contracts/websocket.md)", () => {
		const mgr = createManager();
		seedAlert(mgr, "a1", false);
		const change = mgr.handleMessage({ type: "alert:seen", alertIds: ["unknown"] });
		expect(mgr.getAlerts().get("a1")?.seen).toBe(false);
		expect(change).toEqual({ scope: { entity: "global" }, action: "updated" });
	});

	test("already-seen alert stays seen (seen cannot revert to false)", () => {
		const mgr = createManager();
		seedAlert(mgr, "a1", true);
		mgr.handleMessage({ type: "alert:seen", alertIds: ["a1"] });
		expect(mgr.getAlerts().get("a1")?.seen).toBe(true);
	});
});
