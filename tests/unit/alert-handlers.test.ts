import { describe, expect, test } from "bun:test";
import { AlertQueue } from "../../src/alert-queue";
import { AlertStore } from "../../src/alert-store";
import { handleAlertClearAll, handleAlertDismiss } from "../../src/server/alert-handlers";
import type { HandlerDeps } from "../../src/server/handler-types";
import type { ClientMessage, ServerMessage } from "../../src/types";
import { withTempDir } from "../test-infra";

function makeInput(over: Partial<{ workflowId: string | null; epicId: string | null }> = {}) {
	return {
		type: "workflow-finished" as const,
		title: "t",
		description: "d",
		workflowId: over.workflowId === undefined ? "wf1" : over.workflowId,
		epicId: over.epicId === undefined ? null : over.epicId,
		targetRoute: "/workflow/wf1",
	};
}

interface Harness {
	deps: HandlerDeps;
	broadcasted: ServerMessage[];
	sentTo: ServerMessage[];
}

function makeHarness(queue: AlertQueue): Harness {
	const broadcasted: ServerMessage[] = [];
	const sentTo: ServerMessage[] = [];
	const deps = {
		alertQueue: queue,
		broadcast: (msg: ServerMessage) => broadcasted.push(msg),
		sendTo: (_ws: unknown, msg: ServerMessage) => sentTo.push(msg),
	} as unknown as HandlerDeps;
	return { deps, broadcasted, sentTo };
}

describe("handleAlertClearAll", () => {
	test("clears every alert and broadcasts a single alert:dismissed with all ids", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir), { dedupWindowMs: 0 });
			const r1 = queue.emit(makeInput({ workflowId: "wf-a" }));
			const r2 = queue.emit(makeInput({ workflowId: "wf-b" }));
			expect(r1).not.toBeNull();
			expect(r2).not.toBeNull();
			const ids = [r1?.alert.id, r2?.alert.id].filter(Boolean) as string[];
			expect(queue.list()).toHaveLength(2);

			const h = makeHarness(queue);
			const msg: ClientMessage = { type: "alert:clear-all" };
			await handleAlertClearAll({} as never, msg, h.deps);

			expect(queue.list()).toHaveLength(0);
			expect(h.broadcasted).toHaveLength(1);
			const broadcast = h.broadcasted[0];
			expect(broadcast.type).toBe("alert:dismissed");
			if (broadcast.type !== "alert:dismissed") throw new Error("unreachable");
			expect(broadcast.alertIds.sort()).toEqual(ids.sort());
		});
	});

	test("no-op when queue is empty: no broadcast, no sendTo", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir));
			const h = makeHarness(queue);
			await handleAlertClearAll({} as never, { type: "alert:clear-all" }, h.deps);
			expect(h.broadcasted).toHaveLength(0);
			expect(h.sentTo).toHaveLength(0);
		});
	});

	test("ignores wrong message types (defensive type narrowing)", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir), { dedupWindowMs: 0 });
			queue.emit(makeInput());
			const h = makeHarness(queue);
			await handleAlertClearAll(
				{} as never,
				{ type: "alert:dismiss", alertId: "x" } as ClientMessage,
				h.deps,
			);
			expect(queue.list()).toHaveLength(1);
			expect(h.broadcasted).toHaveLength(0);
		});
	});

	test("dismissed ids match the cleared alerts, allowing live clients to drop them locally", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir), { dedupWindowMs: 0 });
			const r = queue.emit(makeInput({ workflowId: "wf-x" }));
			expect(r).not.toBeNull();
			const id = r?.alert.id;
			const h = makeHarness(queue);
			await handleAlertClearAll({} as never, { type: "alert:clear-all" }, h.deps);
			const broadcast = h.broadcasted[0];
			if (broadcast.type !== "alert:dismissed") throw new Error("unreachable");
			expect(broadcast.alertIds).toEqual([id ?? ""]);
		});
	});

	test("handleAlertDismiss still works after clear-all (registry intact)", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir), { dedupWindowMs: 0 });
			const h = makeHarness(queue);
			const r = queue.emit(makeInput({ workflowId: "wf-y" }));
			const id = r?.alert.id ?? "";
			await handleAlertDismiss({} as never, { type: "alert:dismiss", alertId: id }, h.deps);
			expect(queue.list()).toHaveLength(0);
		});
	});
});
