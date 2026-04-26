import { describe, expect, test } from "bun:test";
import type { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import { handleEpicStartFirstLevel } from "../../src/server/epic-handlers";
import type { HandlerDeps, WsData } from "../../src/server/handler-types";
import { MessageRouter } from "../../src/server/message-router";
import type { ServerMessage, Workflow, WorkflowState } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

async function waitForResult<T>(
	sentMessages: Map<T, ServerMessage[]>,
	ws: T,
	maxWaitMs = 1000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		const msgs = sentMessages.get(ws) ?? [];
		if (msgs.some((m) => m.type === "epic:start-first-level:result" || m.type === "error")) {
			return;
		}
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("Timed out waiting for handler result");
}

function stripInternalFields(w: Workflow): WorkflowState {
	const { steps, ...rest } = w;
	return {
		...rest,
		steps: steps.map(({ sessionId: _sid, prompt: _p, pid: _pid, ...step }) => step),
	};
}

interface SetupOpts {
	workflows: Workflow[];
	failures?: Set<string>;
}

async function setup(opts: SetupOpts) {
	const { mock: ws } = createMockWebSocket();
	const mockWs = ws as unknown as Parameters<typeof handleEpicStartFirstLevel>[0];

	const orchestrators = new Map<string, PipelineOrchestrator>();
	for (const wf of opts.workflows) {
		const orch = {
			getEngine: () => ({ getWorkflow: () => null }),
			startPipelineFromWorkflow(workflow: Workflow) {
				if (opts.failures?.has(workflow.id)) {
					throw new Error(`failed to start ${workflow.id}`);
				}
				// Simulate the orchestrator's state-change side-effect: set
				// status = "running" and trigger a workflow:state broadcast via deps.
				workflow.status = "running";
				workflow.updatedAt = new Date().toISOString();
				deps.broadcastWorkflowState(workflow.id);
			},
		} as unknown as PipelineOrchestrator;
		orchestrators.set(wf.id, orch);
	}

	// `deps` is referenced inside startPipelineFromWorkflow above; declare via let
	// then assign so the closure captures the live reference.
	let deps!: HandlerDeps;
	const helper = createMockHandlerDeps({ orchestrators });
	deps = helper.deps;
	// Override broadcastWorkflowState to actually broadcast a workflow:state for tests.
	deps.broadcastWorkflowState = (workflowId: string) => {
		const wf = opts.workflows.find((w) => w.id === workflowId);
		if (!wf) return;
		helper.broadcastedMessages.push({
			type: "workflow:state",
			workflow: stripInternalFields(wf),
		});
	};

	for (const wf of opts.workflows) {
		await deps.sharedStore.save(wf);
	}

	return {
		ws: mockWs,
		deps,
		sentMessages: helper.sentMessages,
		broadcastedMessages: helper.broadcastedMessages,
	};
}

// The orchestrator is stubbed by the test setup, so this suite verifies the
// router → handler → result-envelope path and the handler's interaction
// contract with the orchestrator (it must invoke startPipelineFromWorkflow
// and pass the eligible workflow). The workflow:state broadcasts asserted
// below are produced by the stub itself, not a real orchestrator — they are
// kept to verify the *handler* hands off to the orchestrator with the live
// workflow reference (so that any state transition the orchestrator drives
// is observable downstream).
describe("integration: epic:start-first-level router dispatch + handler contract", () => {
	test("dispatches through MessageRouter and emits result + workflow:state per started spec", async () => {
		const wfA = makeWorkflow({
			id: "wf-a",
			epicId: "e-1",
			epicDependencies: [],
			status: "idle",
		});
		const wfB = makeWorkflow({
			id: "wf-b",
			epicId: "e-1",
			epicDependencies: [],
			status: "idle",
		});
		const wfDep = makeWorkflow({
			id: "wf-dep",
			epicId: "e-1",
			epicDependencies: ["wf-a"],
			status: "idle",
		});

		const { ws, deps, sentMessages, broadcastedMessages } = await setup({
			workflows: [wfA, wfB, wfDep],
		});

		const router = new MessageRouter();
		router.register("epic:start-first-level", handleEpicStartFirstLevel);

		router.dispatch(ws, JSON.stringify({ type: "epic:start-first-level", epicId: "e-1" }), deps);
		await waitForResult(sentMessages, ws);

		const resultMsg = (sentMessages.get(ws as unknown as Bun.ServerWebSocket<WsData>) ?? []).find(
			(m) => m.type === "epic:start-first-level:result",
		) as Extract<ServerMessage, { type: "epic:start-first-level:result" }> | undefined;
		expect(resultMsg).toBeDefined();
		expect(resultMsg?.epicId).toBe("e-1");
		expect(resultMsg?.started.sort()).toEqual(["wf-a", "wf-b"]);
		expect(resultMsg?.skipped).toEqual(["wf-dep"]);
		expect(resultMsg?.failed).toEqual([]);

		const stateBroadcasts = broadcastedMessages.filter(
			(m) => m.type === "workflow:state",
		) as Extract<ServerMessage, { type: "workflow:state" }>[];
		const broadcastIds = stateBroadcasts.map((m) => m.workflow?.id).filter((x): x is string => !!x);
		expect(broadcastIds.sort()).toEqual(["wf-a", "wf-b"]);
		for (const m of stateBroadcasts) {
			expect(m.workflow?.status).toBe("running");
		}
	});

	test("partial failure produces a result with `failed` and still broadcasts for the successes", async () => {
		const wfA = makeWorkflow({
			id: "wf-a",
			epicId: "e-1",
			epicDependencies: [],
			status: "idle",
		});
		const wfB = makeWorkflow({
			id: "wf-b",
			epicId: "e-1",
			epicDependencies: [],
			status: "idle",
		});
		const wfC = makeWorkflow({
			id: "wf-c",
			epicId: "e-1",
			epicDependencies: [],
			status: "idle",
		});

		const { ws, deps, sentMessages, broadcastedMessages } = await setup({
			workflows: [wfA, wfB, wfC],
			failures: new Set(["wf-b"]),
		});

		const router = new MessageRouter();
		router.register("epic:start-first-level", handleEpicStartFirstLevel);

		router.dispatch(ws, JSON.stringify({ type: "epic:start-first-level", epicId: "e-1" }), deps);
		await waitForResult(sentMessages, ws);

		const resultMsg = (sentMessages.get(ws as unknown as Bun.ServerWebSocket<WsData>) ?? []).find(
			(m) => m.type === "epic:start-first-level:result",
		) as Extract<ServerMessage, { type: "epic:start-first-level:result" }> | undefined;
		expect(resultMsg?.started.sort()).toEqual(["wf-a", "wf-c"]);
		expect(resultMsg?.failed).toHaveLength(1);
		expect(resultMsg?.failed[0].workflowId).toBe("wf-b");
		expect(resultMsg?.skipped).toEqual([]);

		const broadcastIds = broadcastedMessages
			.filter((m) => m.type === "workflow:state")
			.map((m) => (m as Extract<ServerMessage, { type: "workflow:state" }>).workflow?.id ?? null)
			.filter((x): x is string => !!x);
		expect(broadcastIds.sort()).toEqual(["wf-a", "wf-c"]);
	});
});
