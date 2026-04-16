import { describe, expect, test } from "bun:test";
import { AlertQueue } from "../../src/alert-queue";
import { AlertStore } from "../../src/alert-store";
import type { ServerMessage } from "../../src/types";
import { withTempDir } from "../test-infra";

// Mirrors the server.ts emitAlert / dismissAlertsWhere wiring so the
// AlertQueue + broadcast contract is covered end-to-end without needing
// to stand up a real HTTP/WebSocket server.
function createHarness(queue: AlertQueue) {
	const broadcasted: ServerMessage[] = [];
	const broadcast = (msg: ServerMessage) => broadcasted.push(msg);

	const emit = (input: Omit<import("../../src/types").Alert, "id" | "createdAt">) => {
		const r = queue.emit(input);
		if (!r) return null;
		broadcast({ type: "alert:created", alert: r.alert });
		if (r.evictedId) broadcast({ type: "alert:dismissed", alertIds: [r.evictedId] });
		return r;
	};

	const dismissId = (id: string) => {
		if (queue.dismiss(id)) broadcast({ type: "alert:dismissed", alertIds: [id] });
	};

	const dismissWhere = (
		filter: Parameters<AlertQueue["dismissWhere"]>[0],
	) => {
		const removed = queue.dismissWhere(filter);
		if (removed.length > 0) broadcast({ type: "alert:dismissed", alertIds: removed });
		return removed;
	};

	return { emit, dismissId, dismissWhere, broadcasted, broadcast };
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
			const r1 = h.emit({
				type: "workflow-finished",
				title: "Finished",
				description: "One done",
				workflowId: "wf-1",
				epicId: null,
				targetRoute: "/workflow/wf-1",
			});
			expect(r1).not.toBeNull();

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

			// Give the fire-and-forget AlertStore.save calls time to flush.
			await new Promise((r) => setTimeout(r, 30));
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
			await new Promise((r) => setTimeout(r, 30));
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
			const removed = h2.dismissWhere({ type: "question-asked", workflowId: "wf-3" });
			expect(removed).toHaveLength(1);
			const lastBroadcast = h2.broadcasted[h2.broadcasted.length - 1];
			expect(lastBroadcast.type).toBe("alert:dismissed");
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
			expect(kinds).toEqual([
				"alert:created",
				"alert:created",
				"alert:created",
				"alert:dismissed",
			]);
		});
	});
});
