import { describe, expect, test } from "bun:test";
import { ClientStateManager } from "../../src/client/client-state-manager";
import type { ClientMessage, ServerMessage, StateChange } from "../../src/protocol";
import { makeWorkflowState } from "../helpers";
import { makeAppConfig, makePersistedEpic } from "../test-infra/factories";

function setup() {
	const sent: ClientMessage[] = [];
	const mgr = new ClientStateManager((m) => sent.push(m));
	return { mgr, sent };
}

describe("ClientStateManager façade — dispatch routing", () => {
	test("workflow:* messages route to the workflow slice", () => {
		const { mgr } = setup();
		mgr.handleMessage({ type: "workflow:list", workflows: [makeWorkflowState({ id: "wf-1" })] });
		expect(mgr.getWorkflows().has("wf-1")).toBe(true);
		expect(mgr.getEpics().size).toBe(0);
		expect(mgr.getAlerts().size).toBe(0);
	});

	test("epic:* messages route to the epic slice", () => {
		const { mgr } = setup();
		mgr.handleMessage({ type: "epic:created", epicId: "e1", description: "d" });
		expect(mgr.getEpics().has("e1")).toBe(true);
		expect(mgr.getWorkflows().size).toBe(0);
	});

	test("alert:* messages route to the alert slice", () => {
		const { mgr } = setup();
		mgr.handleMessage({
			type: "alert:list",
			alerts: [
				{
					id: "a1",
					type: "epic-finished",
					title: "T",
					description: "D",
					workflowId: null,
					epicId: null,
					targetRoute: "/",
					createdAt: 1,
					seen: false,
				},
			],
		});
		expect(mgr.getAlerts().has("a1")).toBe(true);
		expect(mgr.getWorkflows().size).toBe(0);
	});

	test("epic:dependency-update routes to the workflow slice (writes a workflow field)", () => {
		const { mgr } = setup();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		mgr.handleMessage({
			type: "epic:dependency-update",
			workflowId: "wf-1",
			epicDependencyStatus: "satisfied",
			blockingWorkflows: [],
		});
		expect(mgr.getWorkflows().get("wf-1")?.state.epicDependencyStatus).toBe("satisfied");
	});
});

describe("ClientStateManager façade — cardOrder and aggregates", () => {
	test("cardOrder is rebuilt only when slice flags affectsCardOrder", () => {
		const { mgr } = setup();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({
				id: "wf-1",
				createdAt: "2026-01-01T00:00:00Z",
			}),
		});
		const orderBefore = [...mgr.getCardOrder()];
		expect(orderBefore).toEqual(["wf-1"]);

		// workflow:output does not affect card order
		mgr.handleMessage({ type: "workflow:output", workflowId: "wf-1", text: "x" });
		expect([...mgr.getCardOrder()]).toEqual(orderBefore);
	});

	test("epic aggregates are recomputed when a workflow change affects card order", () => {
		const { mgr } = setup();
		mgr.handleMessage({
			type: "workflow:list",
			workflows: [
				makeWorkflowState({
					id: "c1",
					epicId: "e1",
					epicTitle: "E1",
					status: "running",
					createdAt: "2026-01-01T00:00:00Z",
				}),
				makeWorkflowState({
					id: "c2",
					epicId: "e1",
					epicTitle: "E1",
					status: "completed",
					createdAt: "2026-01-02T00:00:00Z",
				}),
			],
		});
		const agg = mgr.getEpicAggregates().get("e1");
		expect(agg).toBeDefined();
		expect(agg?.progress.total).toBe(2);
		expect(agg?.progress.completed).toBe(1);
	});
});

describe("ClientStateManager façade — single-notification invariant", () => {
	test("listener fires at most once per inbound message and only when notify=true", () => {
		const { mgr } = setup();
		const calls: { change: StateChange; msgType: string }[] = [];
		mgr.onStateChange((c, m) => calls.push({ change: c, msgType: m.type }));

		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		expect(calls.length).toBe(1);
		expect(calls[0].msgType).toBe("workflow:created");

		// auto-archive:state notifies once with scope=none (parity with master).
		mgr.handleMessage({ type: "auto-archive:state", active: true });
		expect(calls.length).toBe(2);
		expect(calls[1].change.scope).toEqual({ entity: "none" });
	});

	test("listener does not fire for console:output (pure dev-console side effect)", () => {
		const { mgr } = setup();
		const calls: StateChange[] = [];
		mgr.onStateChange((c) => calls.push(c));

		const original = console.log;
		const logged: unknown[][] = [];
		console.log = (...args) => {
			logged.push(args);
		};
		try {
			mgr.handleMessage({ type: "console:output", text: "hello" });
		} finally {
			console.log = original;
		}
		expect(calls.length).toBe(0);
		expect(logged.length).toBe(1);
	});

	test("listener does not fire for unknown-id messages (warning path)", () => {
		const { mgr } = setup();
		const calls: StateChange[] = [];
		mgr.onStateChange((c) => calls.push(c));

		mgr.handleMessage({ type: "workflow:output", workflowId: "ghost", text: "x" });
		expect(calls.length).toBe(0);
	});
});

describe("ClientStateManager façade — workflow:aspect:* reducer", () => {
	function workflowWithAspects() {
		return makeWorkflowState({
			id: "wf-1",
			workflowKind: "ask-question",
			aspectManifest: {
				version: 1,
				aspects: [
					{ id: "a", title: "A", researchPrompt: "p", fileName: "a.md" },
					{ id: "b", title: "B", researchPrompt: "p", fileName: "b.md" },
				],
			},
			aspects: [
				{
					id: "a",
					fileName: "a.md",
					status: "in_progress",
					sessionId: null,
					startedAt: "2026-05-03T00:00:00Z",
					completedAt: null,
					errorMessage: null,
					output: "",
					outputLog: [],
				},
				{
					id: "b",
					fileName: "b.md",
					status: "pending",
					sessionId: null,
					startedAt: null,
					completedAt: null,
					errorMessage: null,
					output: "",
					outputLog: [],
				},
			],
		});
	}

	test("workflow:aspect:output appends to the targeted aspect's output + outputLog", () => {
		const { mgr } = setup();
		mgr.handleMessage({ type: "workflow:created", workflow: workflowWithAspects() });
		mgr.handleMessage({
			type: "workflow:aspect:output",
			workflowId: "wf-1",
			aspectId: "a",
			text: "Hello ",
		});
		mgr.handleMessage({
			type: "workflow:aspect:output",
			workflowId: "wf-1",
			aspectId: "a",
			text: "world",
		});
		const wf = mgr.getWorkflows().get("wf-1")?.state;
		const aspect = wf?.aspects?.find((a) => a.id === "a");
		expect(aspect?.output).toBe("Hello world");
		expect(aspect?.outputLog.length).toBe(2);
		// Sibling aspect untouched
		const sibling = wf?.aspects?.find((a) => a.id === "b");
		expect(sibling?.output).toBe("");
	});

	test("workflow:aspect:tools appends a tools entry to the targeted aspect's outputLog", () => {
		const { mgr } = setup();
		mgr.handleMessage({ type: "workflow:created", workflow: workflowWithAspects() });
		mgr.handleMessage({
			type: "workflow:aspect:tools",
			workflowId: "wf-1",
			aspectId: "a",
			tools: [{ name: "Read" }],
		});
		const wf = mgr.getWorkflows().get("wf-1")?.state;
		const aspect = wf?.aspects?.find((a) => a.id === "a");
		expect(aspect?.outputLog.length).toBe(1);
		expect(aspect?.outputLog[0].kind).toBe("tools");
	});

	test("workflow:aspect:state replaces the local aspect with the snapshot", () => {
		const { mgr } = setup();
		mgr.handleMessage({ type: "workflow:created", workflow: workflowWithAspects() });
		mgr.handleMessage({
			type: "workflow:aspect:state",
			workflowId: "wf-1",
			aspectId: "a",
			state: {
				id: "a",
				fileName: "a.md",
				status: "completed",
				sessionId: "sess-a",
				startedAt: "2026-05-03T00:00:00Z",
				completedAt: "2026-05-03T00:01:00Z",
				errorMessage: null,
				output: "done",
				outputLog: [{ kind: "text", text: "done" }],
			},
		});
		const wf = mgr.getWorkflows().get("wf-1")?.state;
		const aspect = wf?.aspects?.find((a) => a.id === "a");
		expect(aspect?.status).toBe("completed");
		expect(aspect?.output).toBe("done");
	});

	test("workflow:aspect:state with empty outputLog preserves a non-empty local mirror", () => {
		const { mgr } = setup();
		mgr.handleMessage({ type: "workflow:created", workflow: workflowWithAspects() });
		// Stream some text first
		mgr.handleMessage({
			type: "workflow:aspect:output",
			workflowId: "wf-1",
			aspectId: "a",
			text: "partial",
		});
		// Pure-status flip: snapshot has no output content
		mgr.handleMessage({
			type: "workflow:aspect:state",
			workflowId: "wf-1",
			aspectId: "a",
			state: {
				id: "a",
				fileName: "a.md",
				status: "completed",
				sessionId: "sess-a",
				startedAt: "2026-05-03T00:00:00Z",
				completedAt: "2026-05-03T00:01:00Z",
				errorMessage: null,
				output: "",
				outputLog: [],
			},
		});
		const wf = mgr.getWorkflows().get("wf-1")?.state;
		const aspect = wf?.aspects?.find((a) => a.id === "a");
		expect(aspect?.status).toBe("completed");
		expect(aspect?.output).toBe("partial");
	});

	test("unknown aspectId on workflow:aspect:output emits a client:warning, not a crash", () => {
		const { mgr, sent } = setup();
		mgr.handleMessage({ type: "workflow:created", workflow: workflowWithAspects() });
		mgr.handleMessage({
			type: "workflow:aspect:output",
			workflowId: "wf-1",
			aspectId: "ghost",
			text: "x",
		});
		expect(sent.some((m) => m.type === "client:warning")).toBe(true);
	});

	test("unknown aspectId on workflow:aspect:state emits a client:warning, not a crash", () => {
		const { mgr, sent } = setup();
		mgr.handleMessage({ type: "workflow:created", workflow: workflowWithAspects() });
		mgr.handleMessage({
			type: "workflow:aspect:state",
			workflowId: "wf-1",
			aspectId: "ghost",
			state: {
				id: "ghost",
				fileName: "ghost.md",
				status: "completed",
				sessionId: null,
				startedAt: "2026-05-03T00:00:00Z",
				completedAt: "2026-05-03T00:01:00Z",
				errorMessage: null,
				output: "x",
				outputLog: [{ kind: "text", text: "x" }],
			},
		});
		expect(sent.some((m) => m.type === "client:warning")).toBe(true);
		// Sibling aspects untouched
		const wf = mgr.getWorkflows().get("wf-1")?.state;
		expect(wf?.aspects?.length).toBe(2);
	});

	test("late joiner: workflow:aspect:state with non-empty outputLog fully replaces local state", () => {
		const { mgr } = setup();
		mgr.handleMessage({ type: "workflow:created", workflow: workflowWithAspects() });
		// Late-joiner snapshot arriving BEFORE any incremental output deltas.
		mgr.handleMessage({
			type: "workflow:aspect:state",
			workflowId: "wf-1",
			aspectId: "a",
			state: {
				id: "a",
				fileName: "a.md",
				status: "completed",
				sessionId: "sess-a",
				startedAt: "2026-05-03T00:00:00Z",
				completedAt: "2026-05-03T00:01:00Z",
				errorMessage: null,
				output: "full snapshot body",
				outputLog: [{ kind: "text", text: "full snapshot body" }],
			},
		});
		const wf = mgr.getWorkflows().get("wf-1")?.state;
		const aspect = wf?.aspects?.find((a) => a.id === "a");
		expect(aspect?.status).toBe("completed");
		expect(aspect?.output).toBe("full snapshot body");
		expect(aspect?.outputLog.length).toBe(1);
		expect(aspect?.sessionId).toBe("sess-a");
	});

	test("pure-flip case: workflow:aspect:state with empty outputLog when local mirror is also empty replaces (status flip)", () => {
		const { mgr } = setup();
		mgr.handleMessage({ type: "workflow:created", workflow: workflowWithAspects() });
		// Aspect 'b' starts pending with empty output. Send a status-only flip
		// snapshot — both incoming and local outputLog are empty, so the local
		// mirror is replaced (status goes pending → completed).
		mgr.handleMessage({
			type: "workflow:aspect:state",
			workflowId: "wf-1",
			aspectId: "b",
			state: {
				id: "b",
				fileName: "b.md",
				status: "completed",
				sessionId: "sess-b",
				startedAt: "2026-05-03T00:00:00Z",
				completedAt: "2026-05-03T00:01:00Z",
				errorMessage: null,
				output: "",
				outputLog: [],
			},
		});
		const wf = mgr.getWorkflows().get("wf-1")?.state;
		const aspect = wf?.aspects?.find((a) => a.id === "b");
		expect(aspect?.status).toBe("completed");
		expect(aspect?.sessionId).toBe("sess-b");
		expect(aspect?.completedAt).toBe("2026-05-03T00:01:00Z");
	});
});

describe("ClientStateManager façade — client:warning forwarding (FR-016)", () => {
	test("forwards an unknown-workflow output message as a client:warning to the server", () => {
		const { mgr, sent } = setup();
		mgr.handleMessage({ type: "workflow:output", workflowId: "ghost", text: "x" });
		expect(sent).toContainEqual({
			type: "client:warning",
			source: "workflow",
			message: "workflow:output for unknown workflowId 'ghost'",
		});
	});

	test("forwards an unknown-epic message as a client:warning with source=epic", () => {
		const { mgr, sent } = setup();
		mgr.handleMessage({ type: "epic:summary", epicId: "ghost", summary: "x" });
		expect(sent).toContainEqual({
			type: "client:warning",
			source: "epic",
			message: "epic:summary for unknown epicId 'ghost'",
		});
	});

	test("does not log warnings to the browser console (no console.warn)", () => {
		const original = console.warn;
		const calls: unknown[][] = [];
		console.warn = (...args) => {
			calls.push(args);
		};
		try {
			const { mgr } = setup();
			mgr.handleMessage({ type: "workflow:output", workflowId: "ghost", text: "x" });
			expect(calls.length).toBe(0);
		} finally {
			console.warn = original;
		}
	});
});

describe("ClientStateManager façade — public API preserved (FR-007)", () => {
	test("getWorkflows / getEpics / getAlerts / getEpicAggregates are read-only views", () => {
		const { mgr } = setup();
		expect(mgr.getWorkflows().size).toBe(0);
		expect(mgr.getEpics().size).toBe(0);
		expect(mgr.getAlerts().size).toBe(0);
		expect(mgr.getEpicAggregates().size).toBe(0);
	});

	test("getCardOrder returns a readonly snapshot of the current order", () => {
		const { mgr } = setup();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		expect([...mgr.getCardOrder()]).toEqual(["wf-1"]);
	});

	test("expandItem mirrors workflow + epic expansion in lockstep", () => {
		const { mgr } = setup();
		mgr.expandItem("epic:e1");
		expect(mgr.getExpandedEpicId()).toBe("e1");
		expect(mgr.getExpandedId()).toBe("epic:e1");
		mgr.expandItem("epic:e1"); // toggles off
		expect(mgr.getExpandedEpicId()).toBeNull();
		expect(mgr.getExpandedId()).toBeNull();
	});

	test("expandItem with a workflow id sets workflow expansion + clears epic expansion", () => {
		const { mgr } = setup();
		mgr.expandItem("epic:e1");
		mgr.expandItem("wf-1");
		expect(mgr.getExpandedId()).toBe("wf-1");
		expect(mgr.getExpandedEpicId()).toBeNull();
	});

	test("selectChild / selectStep / selectStepFor / resetStepSelection mutate via the workflow slice", () => {
		const { mgr } = setup();
		mgr.selectChild("wf-1");
		expect(mgr.getSelectedChildId()).toBe("wf-1");
		mgr.selectStepFor("wf-1", 3);
		expect(mgr.getSelectedStepIndexFor("wf-1")).toBe(3);
		expect(mgr.getSelectedStepIndexFor("wf-other")).toBeNull();
		mgr.resetStepSelection();
		expect(mgr.getSelectedStepIndex()).toBeNull();
	});

	test("addOrUpdateWorkflow inserts and triggers a card-order rebuild for new standalone workflows", () => {
		const { mgr } = setup();
		mgr.addOrUpdateWorkflow(makeWorkflowState({ id: "wf-1", createdAt: "2026-01-01T00:00:00Z" }));
		expect(mgr.getWorkflows().has("wf-1")).toBe(true);
		expect([...mgr.getCardOrder()]).toEqual(["wf-1"]);
	});

	test("getLastTargetRepo returns the most recent repo across workflows", () => {
		const { mgr } = setup();
		mgr.addOrUpdateWorkflow(
			makeWorkflowState({
				id: "wf-1",
				createdAt: "2026-01-01T00:00:00Z",
				targetRepository: "/r1",
			}),
		);
		mgr.addOrUpdateWorkflow(
			makeWorkflowState({
				id: "wf-2",
				createdAt: "2026-01-02T00:00:00Z",
				targetRepository: "/r2",
			}),
		);
		expect(mgr.getLastTargetRepo()).toBe("/r2");
	});
});

describe("ClientStateManager façade — purge:complete and config:state", () => {
	test("purge:complete clears every slice and resets cardOrder", () => {
		const { mgr } = setup();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		mgr.handleMessage({ type: "epic:created", epicId: "e1", description: "d" });
		mgr.handleMessage({ type: "purge:complete", warnings: [] } as ServerMessage);
		expect(mgr.getWorkflows().size).toBe(0);
		expect(mgr.getEpics().size).toBe(0);
		expect(mgr.getAlerts().size).toBe(0);
		expect(mgr.getCardOrder().length).toBe(0);
	});

	test("config:state propagates maxClientOutputLines to both reducers", () => {
		const { mgr } = setup();
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		const cfg = makeAppConfig();
		cfg.timing = { ...cfg.timing, maxClientOutputLines: 2 };
		mgr.handleMessage({ type: "config:state", config: cfg });
		mgr.handleMessage({ type: "workflow:output", workflowId: "wf-1", text: "a" });
		mgr.handleMessage({ type: "workflow:output", workflowId: "wf-1", text: "b" });
		mgr.handleMessage({ type: "workflow:output", workflowId: "wf-1", text: "c" });
		expect(mgr.getWorkflows().get("wf-1")?.outputLines.length).toBe(2);
	});
});

describe("ClientStateManager façade — coverage smoke for all routing cases", () => {
	test("each non-slice inbound message yields a single notify call", () => {
		const { mgr } = setup();
		const calls: StateChange[] = [];
		mgr.onStateChange((c) => calls.push(c));

		mgr.handleMessage({ type: "purge:progress", step: "x", current: 0, total: 1 });
		mgr.handleMessage({ type: "purge:error", message: "x", warnings: [] });
		mgr.handleMessage({ type: "default-model:info", modelInfo: null });
		mgr.handleMessage({ type: "error", message: "x" });

		expect(calls.length).toBe(4);
	});

	test("epic:list seeds the epic slice", () => {
		const { mgr } = setup();
		mgr.handleMessage({ type: "epic:list", epics: [makePersistedEpic({ epicId: "e1" })] });
		expect(mgr.getEpics().has("e1")).toBe(true);
	});
});
