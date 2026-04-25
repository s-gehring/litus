import { describe, expect, test } from "bun:test";
import type { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import { handleArchiveWorkflow, handleUnarchiveWorkflow } from "../../src/server/workflow-handlers";
import type { ClientMessage, ServerMessage, Workflow } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

function setup(workflow?: Partial<Workflow>) {
	const { mock: ws } = createMockWebSocket();
	const mockWs = ws as unknown as Parameters<typeof handleArchiveWorkflow>[0];

	const wf = makeWorkflow(workflow);
	const orchestrators = new Map<string, PipelineOrchestrator>();
	const engine = {
		getWorkflow: () => wf,
		setWorkflow() {},
	};
	orchestrators.set(wf.id, {
		getEngine: () => engine,
	} as unknown as PipelineOrchestrator);

	const { deps, sentMessages, broadcastedMessages, archiveEvents } = createMockHandlerDeps({
		orchestrators,
	});
	return { ws: mockWs, deps, sentMessages, broadcastedMessages, archiveEvents, wf };
}

function deniedTo(
	sent: Map<unknown, ServerMessage[]>,
	ws: unknown,
): Extract<ServerMessage, { type: "workflow:archive-denied" }> {
	const all = sent.get(ws) ?? [];
	const denied = all.find((m) => m.type === "workflow:archive-denied") as Extract<
		ServerMessage,
		{ type: "workflow:archive-denied" }
	>;
	if (!denied) throw new Error("expected workflow:archive-denied");
	return denied;
}

describe("workflow:archive handler", () => {
	test("terminal (completed) workflow archives and broadcasts workflow:state", async () => {
		const { ws, deps, broadcastedMessages, archiveEvents, wf } = setup({ status: "completed" });
		await handleArchiveWorkflow(
			ws,
			{ type: "workflow:archive", workflowId: wf.id } as ClientMessage,
			deps,
		);
		expect(wf.archived).toBe(true);
		expect(wf.archivedAt).not.toBeNull();
		const state = broadcastedMessages.find((m) => m.type === "workflow:state");
		expect(state).toBeDefined();
		expect(archiveEvents).toHaveLength(1);
		expect(archiveEvents[0].eventType).toBe("workflow.archive");
		expect(archiveEvents[0].workflowId).toBe(wf.id);
	});

	test("idle workflow archives (modal is client-side)", async () => {
		const { ws, deps, wf } = setup({ status: "idle" });
		await handleArchiveWorkflow(
			ws,
			{ type: "workflow:archive", workflowId: wf.id } as ClientMessage,
			deps,
		);
		expect(wf.archived).toBe(true);
	});

	test("running workflow is refused with reason not-archivable-state", async () => {
		const { ws, deps, sentMessages, wf } = setup({ status: "running" });
		await handleArchiveWorkflow(
			ws,
			{ type: "workflow:archive", workflowId: wf.id } as ClientMessage,
			deps,
		);
		expect(wf.archived).toBe(false);
		expect(deniedTo(sentMessages, ws).reason).toBe("not-archivable-state");
	});

	test("child spec (epicId set) is refused with reason child-spec-independent-archive", async () => {
		const { ws, deps, sentMessages, wf } = setup({ status: "completed", epicId: "e-1" });
		await handleArchiveWorkflow(
			ws,
			{ type: "workflow:archive", workflowId: wf.id } as ClientMessage,
			deps,
		);
		expect(wf.archived).toBe(false);
		expect(deniedTo(sentMessages, ws).reason).toBe("child-spec-independent-archive");
	});

	test("already archived workflow is refused with reason already-archived", async () => {
		const { ws, deps, sentMessages, wf } = setup({
			status: "completed",
			archived: true,
			archivedAt: "2026-04-22T00:00:00.000Z",
		});
		await handleArchiveWorkflow(
			ws,
			{ type: "workflow:archive", workflowId: wf.id } as ClientMessage,
			deps,
		);
		expect(deniedTo(sentMessages, ws).reason).toBe("already-archived");
	});

	test("unknown workflow id is refused with reason not-found", async () => {
		const { ws, deps, sentMessages } = setup({ status: "completed" });
		await handleArchiveWorkflow(
			ws,
			{ type: "workflow:archive", workflowId: "does-not-exist" } as ClientMessage,
			deps,
		);
		expect(deniedTo(sentMessages, ws).reason).toBe("not-found");
	});
});

describe("workflow:unarchive handler", () => {
	test("archived workflow unarchives and preserves lifecycle state", async () => {
		const { ws, deps, broadcastedMessages, wf } = setup({
			status: "completed",
			archived: true,
			archivedAt: "2026-04-22T00:00:00.000Z",
			activeWorkMs: 12345,
		});
		const prevStatus = wf.status;
		const prevSteps = wf.steps;
		await handleUnarchiveWorkflow(
			ws,
			{ type: "workflow:unarchive", workflowId: wf.id } as ClientMessage,
			deps,
		);
		expect(wf.archived).toBe(false);
		expect(wf.archivedAt).toBeNull();
		expect(wf.status).toBe(prevStatus);
		expect(wf.steps).toBe(prevSteps);
		expect(wf.activeWorkMs).toBe(12345);
		expect(broadcastedMessages.find((m) => m.type === "workflow:state")).toBeDefined();
	});

	test("not-archived workflow is refused with reason already-active", async () => {
		const { ws, deps, sentMessages, wf } = setup({ status: "completed", archived: false });
		await handleUnarchiveWorkflow(
			ws,
			{ type: "workflow:unarchive", workflowId: wf.id } as ClientMessage,
			deps,
		);
		expect(deniedTo(sentMessages, ws).reason).toBe("already-active");
	});

	test("child spec is refused with reason child-spec-independent-archive", async () => {
		const { ws, deps, sentMessages, wf } = setup({
			status: "completed",
			epicId: "e-1",
			archived: true,
			archivedAt: "2026-04-22T00:00:00.000Z",
		});
		await handleUnarchiveWorkflow(
			ws,
			{ type: "workflow:unarchive", workflowId: wf.id } as ClientMessage,
			deps,
		);
		expect(deniedTo(sentMessages, ws).reason).toBe("child-spec-independent-archive");
	});

	test("unknown workflow id is refused with reason not-found", async () => {
		const { ws, deps, sentMessages } = setup();
		await handleUnarchiveWorkflow(
			ws,
			{ type: "workflow:unarchive", workflowId: "nope" } as ClientMessage,
			deps,
		);
		expect(deniedTo(sentMessages, ws).reason).toBe("not-found");
	});
});
