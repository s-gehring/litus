import { describe, expect, test } from "bun:test";
import { AutoArchiver } from "../../src/auto-archiver";
import type { HandlerDeps } from "../../src/server/handler-types";
import type { PersistedEpic, ServerMessage } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockEpicStore, createMockWorkflowStore } from "../test-infra/mock-stores";

const THRESHOLD_MS = 30_000;
const OLD_TIMESTAMP = new Date(Date.now() - 5 * 60_000).toISOString();
const FRESH_TIMESTAMP = new Date().toISOString();

function makeEpic(overrides: Partial<PersistedEpic> = {}): PersistedEpic {
	return {
		epicId: overrides.epicId ?? `epic-${Math.random()}`,
		description: "test epic",
		status: "completed",
		title: "Test epic",
		workflowIds: [],
		startedAt: "2026-04-01T00:00:00.000Z",
		completedAt: OLD_TIMESTAMP,
		errorMessage: null,
		infeasibleNotes: null,
		analysisSummary: null,
		archived: false,
		archivedAt: null,
		...overrides,
	};
}

function setupHarness() {
	const workflowStore = createMockWorkflowStore();
	const epicStore = createMockEpicStore();
	const { deps, broadcastedMessages, archiveEvents } = createMockHandlerDeps({
		sharedStore: workflowStore.mock as unknown as HandlerDeps["sharedStore"],
		sharedEpicStore: epicStore.mock as unknown as HandlerDeps["sharedEpicStore"],
	});
	return { workflowStore, epicStore, deps, broadcastedMessages, archiveEvents };
}

describe("AutoArchiver.sweep — standalone workflows", () => {
	test("archives terminal standalone workflows older than threshold", async () => {
		const { workflowStore, deps } = setupHarness();
		const oldDone = makeWorkflow({
			id: "old-done",
			status: "completed",
			updatedAt: OLD_TIMESTAMP,
		});
		const oldAborted = makeWorkflow({
			id: "old-aborted",
			status: "aborted",
			updatedAt: OLD_TIMESTAMP,
		});
		const oldError = makeWorkflow({
			id: "old-error",
			status: "error",
			updatedAt: OLD_TIMESTAMP,
		});
		workflowStore.seedWorkflow(oldDone);
		workflowStore.seedWorkflow(oldAborted);
		workflowStore.seedWorkflow(oldError);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		expect(oldDone.archived).toBe(true);
		expect(oldAborted.archived).toBe(true);
		expect(oldError.archived).toBe(true);
	});

	test("does not archive terminal workflows younger than threshold", async () => {
		const { workflowStore, deps } = setupHarness();
		const fresh = makeWorkflow({
			id: "fresh",
			status: "completed",
			updatedAt: FRESH_TIMESTAMP,
		});
		workflowStore.seedWorkflow(fresh);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		expect(fresh.archived).toBe(false);
	});

	test("does not archive non-terminal workflows", async () => {
		const { workflowStore, deps } = setupHarness();
		const running = makeWorkflow({
			id: "running",
			status: "running",
			updatedAt: OLD_TIMESTAMP,
		});
		const idle = makeWorkflow({ id: "idle", status: "idle", updatedAt: OLD_TIMESTAMP });
		const paused = makeWorkflow({ id: "paused", status: "paused", updatedAt: OLD_TIMESTAMP });
		workflowStore.seedWorkflow(running);
		workflowStore.seedWorkflow(idle);
		workflowStore.seedWorkflow(paused);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		expect(running.archived).toBe(false);
		expect(idle.archived).toBe(false);
		expect(paused.archived).toBe(false);
	});

	test("skips already-archived workflows", async () => {
		const { workflowStore, deps, archiveEvents } = setupHarness();
		const already = makeWorkflow({
			id: "already",
			status: "completed",
			updatedAt: OLD_TIMESTAMP,
			archived: true,
			archivedAt: "2026-04-01T00:00:00.000Z",
		});
		workflowStore.seedWorkflow(already);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		expect(archiveEvents).toHaveLength(0);
	});

	test("does not archive epic-children directly (epic-archive cascade owns them)", async () => {
		const { workflowStore, epicStore, deps } = setupHarness();
		// Epic is still analyzing — children must NOT be archived even if they
		// are old and terminal, otherwise we'd orphan children under a live epic.
		const epic = makeEpic({
			epicId: "e1",
			status: "analyzing",
			completedAt: null,
			workflowIds: ["c1"],
		});
		await epicStore.mock.save(epic);
		const child = makeWorkflow({
			id: "c1",
			status: "completed",
			epicId: "e1",
			updatedAt: OLD_TIMESTAMP,
		});
		workflowStore.seedWorkflow(child);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		expect(child.archived).toBe(false);
		expect(epic.archived).toBe(false);
	});

	test("broadcasts workflow:state on archive", async () => {
		const { workflowStore, deps, broadcastedMessages, archiveEvents } = setupHarness();
		const wf = makeWorkflow({ id: "wf-1", status: "completed", updatedAt: OLD_TIMESTAMP });
		workflowStore.seedWorkflow(wf);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		const state = broadcastedMessages.find(
			(m): m is Extract<ServerMessage, { type: "workflow:state" }> => m.type === "workflow:state",
		);
		expect(state).toBeDefined();
		expect(state?.workflow?.id).toBe("wf-1");
		expect(archiveEvents).toHaveLength(1);
		expect(archiveEvents[0].eventType).toBe("workflow.archive");
	});
});

describe("AutoArchiver.sweep — epics", () => {
	test("archives terminal epic + cascades to ALL children regardless of child status", async () => {
		const { workflowStore, epicStore, deps, broadcastedMessages, archiveEvents } = setupHarness();
		const epic = makeEpic({
			epicId: "e1",
			status: "completed",
			workflowIds: ["c1", "c2", "c3"],
			completedAt: OLD_TIMESTAMP,
		});
		await epicStore.mock.save(epic);
		const c1 = makeWorkflow({
			id: "c1",
			status: "completed",
			epicId: "e1",
			updatedAt: OLD_TIMESTAMP,
		});
		const c2 = makeWorkflow({
			id: "c2",
			status: "aborted",
			epicId: "e1",
			updatedAt: FRESH_TIMESTAMP,
		});
		// Even non-terminal idle/waiting children get archived alongside a
		// done epic — a finished epic implies its children are done from a
		// user perspective.
		const c3 = makeWorkflow({ id: "c3", status: "idle", epicId: "e1", updatedAt: OLD_TIMESTAMP });
		workflowStore.seedWorkflow(c1);
		workflowStore.seedWorkflow(c2);
		workflowStore.seedWorkflow(c3);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		expect(epic.archived).toBe(true);
		expect(epic.archivedAt).not.toBeNull();
		expect(c1.archived).toBe(true);
		expect(c2.archived).toBe(true);
		expect(c3.archived).toBe(true);

		const epicList = broadcastedMessages.find(
			(m): m is Extract<ServerMessage, { type: "epic:list" }> => m.type === "epic:list",
		);
		expect(epicList).toBeDefined();
		expect(archiveEvents.some((e) => e.eventType === "epic.archive" && e.epicId === "e1")).toBe(
			true,
		);
		const stateBroadcasts = broadcastedMessages.filter((m) => m.type === "workflow:state");
		expect(stateBroadcasts).toHaveLength(3);
	});

	test("archives epics in error and infeasible states", async () => {
		const { epicStore, deps } = setupHarness();
		const errored = makeEpic({
			epicId: "e-err",
			status: "error",
			completedAt: OLD_TIMESTAMP,
		});
		const infeasible = makeEpic({
			epicId: "e-inf",
			status: "infeasible",
			completedAt: OLD_TIMESTAMP,
		});
		await epicStore.mock.save(errored);
		await epicStore.mock.save(infeasible);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		expect(errored.archived).toBe(true);
		expect(infeasible.archived).toBe(true);
	});

	test("does not archive analyzing epic", async () => {
		const { epicStore, deps } = setupHarness();
		const analyzing = makeEpic({
			epicId: "e-an",
			status: "analyzing",
			completedAt: null,
		});
		await epicStore.mock.save(analyzing);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		expect(analyzing.archived).toBe(false);
	});

	test("does not archive epic with too-recent completedAt", async () => {
		const { epicStore, deps } = setupHarness();
		const fresh = makeEpic({
			epicId: "e-fresh",
			status: "completed",
			completedAt: FRESH_TIMESTAMP,
		});
		await epicStore.mock.save(fresh);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		expect(fresh.archived).toBe(false);
	});

	test("does not archive epic with running children (defensive)", async () => {
		const { workflowStore, epicStore, deps } = setupHarness();
		const epic = makeEpic({
			epicId: "e1",
			status: "completed",
			workflowIds: ["c1"],
			completedAt: OLD_TIMESTAMP,
		});
		await epicStore.mock.save(epic);
		const running = makeWorkflow({
			id: "c1",
			status: "running",
			epicId: "e1",
			updatedAt: OLD_TIMESTAMP,
		});
		workflowStore.seedWorkflow(running);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		expect(epic.archived).toBe(false);
		expect(running.archived).toBe(false);
	});

	test("skips already-archived epics", async () => {
		const { epicStore, deps, archiveEvents } = setupHarness();
		const already = makeEpic({
			epicId: "e-already",
			status: "completed",
			completedAt: OLD_TIMESTAMP,
			archived: true,
			archivedAt: "2026-04-01T00:00:00.000Z",
		});
		await epicStore.mock.save(already);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		expect(archiveEvents.filter((e) => e.eventType === "epic.archive")).toHaveLength(0);
	});

	test("preserves an already-archived child when re-cascading (no double-archive)", async () => {
		const { workflowStore, epicStore, deps } = setupHarness();
		const epic = makeEpic({
			epicId: "e1",
			status: "completed",
			completedAt: OLD_TIMESTAMP,
			workflowIds: ["c1", "c2"],
		});
		await epicStore.mock.save(epic);
		const previouslyArchived = makeWorkflow({
			id: "c1",
			status: "completed",
			epicId: "e1",
			archived: true,
			archivedAt: "2026-04-01T00:00:00.000Z",
			updatedAt: "2026-04-01T00:00:00.000Z",
		});
		const c2 = makeWorkflow({
			id: "c2",
			status: "completed",
			epicId: "e1",
			updatedAt: OLD_TIMESTAMP,
		});
		workflowStore.seedWorkflow(previouslyArchived);
		workflowStore.seedWorkflow(c2);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS);
		await archiver.sweep();

		expect(previouslyArchived.archivedAt).toBe("2026-04-01T00:00:00.000Z");
		expect(c2.archived).toBe(true);
	});
});

describe("AutoArchiver.start", () => {
	test("triggers an immediate sweep so backlog is archived without waiting an interval", async () => {
		const { workflowStore, deps } = setupHarness();
		const old = makeWorkflow({ id: "old", status: "completed", updatedAt: OLD_TIMESTAMP });
		workflowStore.seedWorkflow(old);

		const archiver = new AutoArchiver(deps, THRESHOLD_MS, 60_000);
		archiver.start();
		// Yield to let the unawaited initial sweep complete.
		await new Promise((r) => setTimeout(r, 10));
		archiver.stop();

		expect(old.archived).toBe(true);
	});
});
