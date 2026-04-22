import { describe, expect, test } from "bun:test";
import { handleArchiveEpic, handleUnarchiveEpic } from "../../src/server/epic-handlers";
import type { ClientMessage, PersistedEpic, ServerMessage, Workflow } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { makePersistedEpic } from "../test-infra/factories";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

interface Scenario {
	epic: PersistedEpic;
	children: Workflow[];
}

async function setup(scenario?: Partial<Scenario>) {
	const { mock: ws } = createMockWebSocket();
	const mockWs = ws as unknown as Parameters<typeof handleArchiveEpic>[0];
	const { deps, sentMessages, broadcastedMessages, archiveEvents } = createMockHandlerDeps();

	const children = scenario?.children ?? [];
	const epic =
		scenario?.epic ?? makePersistedEpic({ epicId: "e-1", workflowIds: children.map((c) => c.id) });
	await deps.sharedEpicStore.save(epic);
	for (const child of children) {
		await deps.sharedStore.save(child);
	}
	return { ws: mockWs, deps, sentMessages, broadcastedMessages, archiveEvents, epic, children };
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

describe("epic:archive handler", () => {
	test("happy path archives epic and all children with matching archivedAt", async () => {
		const c1 = makeWorkflow({ id: "w-1", epicId: "e-1", status: "completed" });
		const c2 = makeWorkflow({ id: "w-2", epicId: "e-1", status: "idle" });
		const c3 = makeWorkflow({ id: "w-3", epicId: "e-1", status: "paused" });
		const epic = makePersistedEpic({ epicId: "e-1", workflowIds: [c1.id, c2.id, c3.id] });
		const { ws, deps, broadcastedMessages, archiveEvents } = await setup({
			epic,
			children: [c1, c2, c3],
		});

		await handleArchiveEpic(ws, { type: "epic:archive", epicId: "e-1" } as ClientMessage, deps);

		expect(epic.archived).toBe(true);
		for (const c of [c1, c2, c3]) {
			expect(c.archived).toBe(true);
			expect(c.archivedAt).toBe(epic.archivedAt);
		}
		expect(broadcastedMessages.some((m) => m.type === "epic:list")).toBe(true);
		expect(broadcastedMessages.filter((m) => m.type === "workflow:state")).toHaveLength(3);
		expect(archiveEvents).toHaveLength(1);
		expect(archiveEvents[0].eventType).toBe("epic.archive");
	});

	test("refuses when any child is running and lists every running child", async () => {
		const r1 = makeWorkflow({
			id: "w-r1",
			epicId: "e-1",
			status: "running",
			summary: "Run One",
		});
		const r2 = makeWorkflow({
			id: "w-r2",
			epicId: "e-1",
			status: "running",
			summary: "Run Two",
		});
		const idle = makeWorkflow({ id: "w-idle", epicId: "e-1", status: "idle" });
		const epic = makePersistedEpic({
			epicId: "e-1",
			workflowIds: [r1.id, r2.id, idle.id],
		});
		const { ws, deps, sentMessages } = await setup({ epic, children: [r1, r2, idle] });

		await handleArchiveEpic(ws, { type: "epic:archive", epicId: "e-1" } as ClientMessage, deps);

		const denied = deniedTo(sentMessages, ws);
		expect(denied.reason).toBe("not-archivable-state");
		expect(denied.message).toContain("Run One");
		expect(denied.message).toContain("Run Two");
		expect(epic.archived).toBe(false);
		for (const c of [r1, r2, idle]) expect(c.archived).toBe(false);
	});

	test("idempotent: already-archived epic is refused with already-archived", async () => {
		const epic = makePersistedEpic({
			epicId: "e-1",
			archived: true,
			archivedAt: "2026-04-22T00:00:00.000Z",
		});
		const { ws, deps, sentMessages } = await setup({ epic });

		await handleArchiveEpic(ws, { type: "epic:archive", epicId: "e-1" } as ClientMessage, deps);
		expect(deniedTo(sentMessages, ws).reason).toBe("already-archived");
	});

	test("unknown epic id returns not-found", async () => {
		const { ws, deps, sentMessages } = await setup();
		await handleArchiveEpic(ws, { type: "epic:archive", epicId: "missing" } as ClientMessage, deps);
		expect(deniedTo(sentMessages, ws).reason).toBe("not-found");
	});

	test("second call skips already-archived children and still archives the epic", async () => {
		// Simulated partial prior failure: children archived but epic still active.
		const c1 = makeWorkflow({
			id: "w-1",
			epicId: "e-1",
			status: "completed",
			archived: true,
			archivedAt: "2026-04-22T00:00:00.000Z",
		});
		const c2 = makeWorkflow({ id: "w-2", epicId: "e-1", status: "idle" });
		const epic = makePersistedEpic({ epicId: "e-1", workflowIds: [c1.id, c2.id] });
		const { ws, deps, broadcastedMessages } = await setup({ epic, children: [c1, c2] });

		await handleArchiveEpic(ws, { type: "epic:archive", epicId: "e-1" } as ClientMessage, deps);

		expect(epic.archived).toBe(true);
		expect(c1.archivedAt).toBe("2026-04-22T00:00:00.000Z"); // untouched
		expect(c2.archived).toBe(true);
		// Only the newly-archived child fan-out should produce a workflow:state.
		const stateBroadcasts = broadcastedMessages.filter((m) => m.type === "workflow:state");
		expect(stateBroadcasts).toHaveLength(1);
	});

	test("persist-failed on epic save rolls back epic state and does not touch children", async () => {
		const c1 = makeWorkflow({ id: "w-1", epicId: "e-1", status: "idle" });
		const epic = makePersistedEpic({ epicId: "e-1", workflowIds: [c1.id] });
		const { ws, deps, sentMessages } = await setup({ epic, children: [c1] });

		const originalSave = deps.sharedEpicStore.save.bind(deps.sharedEpicStore);
		deps.sharedEpicStore.save = async () => {
			throw new Error("disk full");
		};
		await handleArchiveEpic(ws, { type: "epic:archive", epicId: "e-1" } as ClientMessage, deps);
		deps.sharedEpicStore.save = originalSave;

		expect(deniedTo(sentMessages, ws).reason).toBe("persist-failed");
		expect(epic.archived).toBe(false);
		expect(c1.archived).toBe(false);
	});
});

describe("epic:unarchive handler", () => {
	test("happy path unarchives epic and all archived children", async () => {
		const c1 = makeWorkflow({
			id: "w-1",
			epicId: "e-1",
			status: "completed",
			archived: true,
			archivedAt: "2026-04-22T00:00:00.000Z",
		});
		const c2 = makeWorkflow({
			id: "w-2",
			epicId: "e-1",
			status: "idle",
			archived: true,
			archivedAt: "2026-04-22T00:00:00.000Z",
		});
		const epic = makePersistedEpic({
			epicId: "e-1",
			workflowIds: [c1.id, c2.id],
			archived: true,
			archivedAt: "2026-04-22T00:00:00.000Z",
		});
		const { ws, deps, broadcastedMessages, archiveEvents } = await setup({
			epic,
			children: [c1, c2],
		});

		await handleUnarchiveEpic(ws, { type: "epic:unarchive", epicId: "e-1" } as ClientMessage, deps);

		expect(epic.archived).toBe(false);
		expect(epic.archivedAt).toBeNull();
		for (const c of [c1, c2]) {
			expect(c.archived).toBe(false);
			expect(c.archivedAt).toBeNull();
		}
		expect(broadcastedMessages.some((m) => m.type === "epic:list")).toBe(true);
		expect(archiveEvents).toHaveLength(1);
		expect(archiveEvents[0].eventType).toBe("epic.unarchive");
	});

	test("refuses already-active epic with already-active", async () => {
		const epic = makePersistedEpic({ epicId: "e-1" });
		const { ws, deps, sentMessages } = await setup({ epic });
		await handleUnarchiveEpic(ws, { type: "epic:unarchive", epicId: "e-1" } as ClientMessage, deps);
		expect(deniedTo(sentMessages, ws).reason).toBe("already-active");
	});

	test("unknown epic id returns not-found", async () => {
		const { ws, deps, sentMessages } = await setup();
		await handleUnarchiveEpic(
			ws,
			{ type: "epic:unarchive", epicId: "missing" } as ClientMessage,
			deps,
		);
		expect(deniedTo(sentMessages, ws).reason).toBe("not-found");
	});
});
