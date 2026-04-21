import { describe, expect, test } from "bun:test";
import { AlertQueue } from "../../src/alert-queue";
import { AlertStore } from "../../src/alert-store";
import { createAlertBroadcasters } from "../../src/server/alert-broadcast";
import type { ServerMessage } from "../../src/types";
import { withTempDir } from "../test-infra";

// Uses the real `createAlertBroadcasters` helper from server.ts so a regression
// in the emit/dismiss broadcast wiring would be caught here.
function createHarness(queue: AlertQueue) {
	const broadcasted: ServerMessage[] = [];
	const broadcast = (msg: ServerMessage) => {
		broadcasted.push(msg);
	};
	const activePaths: Set<string> = new Set();
	const { emitAlert, dismissAlertsWhere, markAlertsSeenWhere } = createAlertBroadcasters(
		queue,
		broadcast,
		() => activePaths,
	);
	const dismissId = (id: string) => {
		if (queue.dismiss(id)) broadcast({ type: "alert:dismissed", alertIds: [id] });
	};
	return {
		emit: emitAlert,
		dismissId,
		dismissWhere: dismissAlertsWhere,
		markSeenWhere: markAlertsSeenWhere,
		broadcasted,
		broadcast,
		activePaths,
	};
}

describe("alert lifecycle", () => {
	test("emit → broadcast → persist → reload → dismiss", async () => {
		await withTempDir(async (dir) => {
			const store = new AlertStore(dir);
			let tick = 1_000_000;
			const clock = () => tick;
			const queue = new AlertQueue(store, { now: clock, dedupWindowMs: 0 });

			const h = createHarness(queue);

			tick += 1;
			h.emit({
				type: "workflow-finished",
				title: "Finished",
				description: "One done",
				workflowId: "wf-1",
				epicId: null,
				targetRoute: "/workflow/wf-1",
			});

			tick += 1;
			h.emit({
				type: "error",
				title: "Err",
				description: "boom",
				workflowId: "wf-2",
				epicId: null,
				targetRoute: "/workflow/wf-2",
			});

			expect(h.broadcasted.filter((m) => m.type === "alert:created")).toHaveLength(2);

			await queue.flush();
			const onDisk = await store.load();
			expect(onDisk).toHaveLength(2);

			// Simulate a restart: new queue, same store.
			const reloaded = new AlertQueue(new AlertStore(dir), { now: clock });
			await reloaded.loadFromDisk();
			expect(reloaded.list()).toHaveLength(2);

			// Dismiss via the harness.
			const firstId = reloaded.list()[0].id;
			const h2 = createHarness(reloaded);
			h2.dismissId(firstId);
			expect(h2.broadcasted).toEqual([{ type: "alert:dismissed", alertIds: [firstId] }]);
			await reloaded.flush();
			expect((await store.load()).map((a) => a.id)).not.toContain(firstId);

			// Auto-clear broadcast for question alerts.
			tick += 10_000;
			h2.emit({
				type: "question-asked",
				title: "Q",
				description: "?",
				workflowId: "wf-3",
				epicId: null,
				targetRoute: "/workflow/wf-3",
			});
			h2.dismissWhere({ type: "question-asked", workflowId: "wf-3" });
			const lastBroadcast = h2.broadcasted[h2.broadcasted.length - 1];
			expect(lastBroadcast.type).toBe("alert:dismissed");
			await reloaded.flush();
		});
	});

	test("US1: question-answered flips matching question-asked alerts to seen and broadcasts", async () => {
		await withTempDir(async (dir) => {
			let tick = 1_000_000;
			const queue = new AlertQueue(new AlertStore(dir), { now: () => tick, dedupWindowMs: 0 });
			const h = createHarness(queue);

			tick++;
			h.emit({
				type: "question-asked",
				title: "Q",
				description: "?",
				workflowId: "wf-q",
				epicId: null,
				targetRoute: "/workflow/wf-q",
			});
			tick++;
			// Simulate workflow leaving waiting_for_input: mark question-asked alerts
			// for that workflow seen.
			h.markSeenWhere((a) => a.type === "question-asked" && a.workflowId === "wf-q");
			await queue.flush();

			const seenMsgs = h.broadcasted.filter((m) => m.type === "alert:seen");
			expect(seenMsgs).toHaveLength(1);
			expect(queue.list()[0].seen).toBe(true);
			expect((await new AlertStore(dir).load())[0].seen).toBe(true);
		});
	});

	test("US1: idempotent — already-seen alert produces no further alert:seen broadcast", async () => {
		await withTempDir(async (dir) => {
			let tick = 1_000_000;
			const queue = new AlertQueue(new AlertStore(dir), { now: () => tick, dedupWindowMs: 0 });
			const h = createHarness(queue);

			tick++;
			h.emit({
				type: "question-asked",
				title: "Q",
				description: "?",
				workflowId: "wf-q",
				epicId: null,
				targetRoute: "/workflow/wf-q",
			});
			h.markSeenWhere((a) => a.workflowId === "wf-q");
			const seenBefore = h.broadcasted.filter((m) => m.type === "alert:seen").length;

			// Cancel / error-out path triggers the same mark again; should be a no-op.
			h.markSeenWhere((a) => a.workflowId === "wf-q");
			const seenAfter = h.broadcasted.filter((m) => m.type === "alert:seen").length;
			expect(seenAfter).toBe(seenBefore);
		});
	});

	test("US2: navigation to matching route flips all navigation-dismissable types but not errors", async () => {
		await withTempDir(async (dir) => {
			let tick = 1_000_000;
			const queue = new AlertQueue(new AlertStore(dir), { now: () => tick, dedupWindowMs: 0 });
			const h = createHarness(queue);

			const navTypes: Array<"workflow-finished" | "pr-opened-manual"> = [
				"workflow-finished",
				"pr-opened-manual",
			];
			const ids: string[] = [];
			for (const type of navTypes) {
				tick++;
				const r = h.broadcasted.length;
				h.emit({
					type,
					title: type,
					description: "",
					workflowId: "wf-n",
					epicId: null,
					targetRoute: "/workflow/wf-n",
				});
				const created = h.broadcasted[r];
				if (created.type === "alert:created") ids.push(created.alert.id);
			}
			// Epic-finished alert on a different route.
			tick++;
			h.emit({
				type: "epic-finished",
				title: "Epic done",
				description: "",
				workflowId: null,
				epicId: "ep1",
				targetRoute: "/epic/ep1",
			});
			// Error alert, same workflow route — must stay unseen.
			tick++;
			h.emit({
				type: "error",
				title: "Err",
				description: "",
				workflowId: "wf-n",
				epicId: null,
				targetRoute: "/workflow/wf-n",
			});

			// Navigate to /workflow/wf-n.
			h.markSeenWhere((a) => a.targetRoute === "/workflow/wf-n");
			const seenBroadcasts = h.broadcasted.filter((m) => m.type === "alert:seen");
			expect(seenBroadcasts).toHaveLength(1);
			if (seenBroadcasts[0].type !== "alert:seen") throw new Error("unreachable");
			expect(new Set(seenBroadcasts[0].alertIds)).toEqual(new Set(ids));

			// Navigate to /epic/ep1.
			h.markSeenWhere((a) => a.targetRoute === "/epic/ep1");
			expect(h.broadcasted.filter((m) => m.type === "alert:seen")).toHaveLength(2);

			// Error alert untouched.
			const list = queue.list();
			const err = list.find((a) => a.type === "error");
			expect(err?.seen).toBe(false);
		});
	});

	test("US2: create-as-seen — non-error alert whose targetRoute matches a live client's path is created seen", async () => {
		await withTempDir(async (dir) => {
			let tick = 1_000_000;
			const queue = new AlertQueue(new AlertStore(dir), { now: () => tick, dedupWindowMs: 0 });
			const h = createHarness(queue);

			h.activePaths.add("/workflow/wf-cas");

			tick++;
			h.emit({
				type: "workflow-finished",
				title: "Done",
				description: "",
				workflowId: "wf-cas",
				epicId: null,
				targetRoute: "/workflow/wf-cas",
			});
			const created = h.broadcasted[0];
			if (created.type !== "alert:created") throw new Error("expected alert:created");
			expect(created.alert.seen).toBe(true);

			// Error alert ignores active-paths set.
			tick++;
			h.emit({
				type: "error",
				title: "Err",
				description: "",
				workflowId: "wf-cas",
				epicId: null,
				targetRoute: "/workflow/wf-cas",
			});
			const errMsg = h.broadcasted[1];
			if (errMsg.type !== "alert:created") throw new Error("expected alert:created");
			expect(errMsg.alert.seen).toBe(false);
		});
	});

	test("US3: error alert at a matching route does not flip to seen via navigation", async () => {
		await withTempDir(async (dir) => {
			let tick = 1_000_000;
			const queue = new AlertQueue(new AlertStore(dir), { now: () => tick, dedupWindowMs: 0 });
			const h = createHarness(queue);

			tick++;
			h.emit({
				type: "error",
				title: "Err",
				description: "",
				workflowId: "wf-e",
				epicId: null,
				targetRoute: "/workflow/wf-e",
			});

			h.markSeenWhere((a) => a.targetRoute === "/workflow/wf-e");
			expect(h.broadcasted.filter((m) => m.type === "alert:seen")).toHaveLength(0);
			expect(queue.list()[0].seen).toBe(false);

			// Explicit dismiss still removes it.
			h.dismissId(queue.list()[0].id);
			expect(queue.list()).toHaveLength(0);
		});
	});

	test("cap eviction broadcasts alert:dismissed alongside alert:created", async () => {
		await withTempDir(async (dir) => {
			const store = new AlertStore(dir);
			let tick = 1_000_000;
			const queue = new AlertQueue(store, {
				now: () => tick,
				maxAlerts: 2,
				dedupWindowMs: 0,
			});
			const h = createHarness(queue);

			tick++;
			h.emit({
				type: "workflow-finished",
				title: "A",
				description: "",
				workflowId: "a",
				epicId: null,
				targetRoute: "/workflow/a",
			});
			tick++;
			h.emit({
				type: "workflow-finished",
				title: "B",
				description: "",
				workflowId: "b",
				epicId: null,
				targetRoute: "/workflow/b",
			});
			tick++;
			h.emit({
				type: "workflow-finished",
				title: "C",
				description: "",
				workflowId: "c",
				epicId: null,
				targetRoute: "/workflow/c",
			});

			const kinds = h.broadcasted.map((m) => m.type);
			expect(kinds).toEqual(["alert:created", "alert:created", "alert:created", "alert:dismissed"]);
			await queue.flush();
		});
	});
});
