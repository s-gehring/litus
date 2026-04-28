import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { AlertQueue } from "../../src/alert-queue";
import { AlertStore } from "../../src/alert-store";
import type { ClientMessage, ServerMessage } from "../../src/protocol";
import { createAlertBroadcasters } from "../../src/server/alert-broadcast";
import {
	clearClientRouteOnClose,
	handleAlertClearAll,
	handleAlertDismiss,
	handleAlertRouteChanged,
} from "../../src/server/alert-handlers";
import type { HandlerDeps, WsData } from "../../src/server/handler-types";
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
});

describe("handleAlertRouteChanged", () => {
	test("flips eligible non-error alerts to seen and broadcasts", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir), { dedupWindowMs: 0 });
			const r1 = queue.emit({
				type: "workflow-finished",
				title: "Done",
				description: "",
				workflowId: "wf-a",
				epicId: null,
				targetRoute: "/workflow/wf-a",
			});
			const r2 = queue.emit({
				type: "error",
				title: "Err",
				description: "",
				workflowId: "wf-a",
				epicId: null,
				targetRoute: "/workflow/wf-a",
			});
			if (!r1 || !r2) throw new Error("emit returned null");

			const broadcasted: ServerMessage[] = [];
			const clientRoutes = new Map<ServerWebSocket<WsData>, string>();
			const { markAlertsSeenWhere } = createAlertBroadcasters(
				queue,
				(m) => broadcasted.push(m),
				() => clientRoutes.values(),
			);
			const deps = {
				alertQueue: queue,
				broadcast: (msg: ServerMessage) => broadcasted.push(msg),
				sendTo: () => {},
				clientRoutes,
				markAlertsSeenWhere,
			} as unknown as HandlerDeps;
			const fakeWs = {} as ServerWebSocket<WsData>;

			await handleAlertRouteChanged(
				fakeWs,
				{ type: "alert:route-changed", path: "/workflow/wf-a" },
				deps,
			);

			expect(clientRoutes.get(fakeWs)).toBe("/workflow/wf-a");
			expect(broadcasted).toHaveLength(1);
			const m = broadcasted[0];
			if (m.type !== "alert:seen") throw new Error("expected alert:seen");
			expect(m.alertIds).toEqual([r1.alert.id]);

			// Error alert stays unseen (FR-006).
			const listed = queue.list();
			expect(listed.find((a) => a.id === r2.alert.id)?.seen).toBe(false);
		});
	});

	test("excludes error alerts regardless of targetRoute match", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir), { dedupWindowMs: 0 });
			const r = queue.emit({
				type: "error",
				title: "Err",
				description: "",
				workflowId: "wf-e",
				epicId: null,
				targetRoute: "/workflow/wf-e",
			});
			if (!r) throw new Error("emit returned null");

			const broadcasted: ServerMessage[] = [];
			const clientRoutes = new Map<ServerWebSocket<WsData>, string>();
			const { markAlertsSeenWhere } = createAlertBroadcasters(
				queue,
				(m) => broadcasted.push(m),
				() => clientRoutes.values(),
			);
			const deps = {
				alertQueue: queue,
				broadcast: () => {},
				sendTo: () => {},
				clientRoutes,
				markAlertsSeenWhere,
			} as unknown as HandlerDeps;
			const fakeWs = {} as ServerWebSocket<WsData>;

			await handleAlertRouteChanged(
				fakeWs,
				{ type: "alert:route-changed", path: "/workflow/wf-e" },
				deps,
			);

			expect(broadcasted).toHaveLength(0);
			expect(queue.list()[0].seen).toBe(false);
		});
	});

	test("normalizes trailing slash server-side so /workflow/abc/ matches targetRoute /workflow/abc", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir), { dedupWindowMs: 0 });
			const r = queue.emit({
				type: "workflow-finished",
				title: "Done",
				description: "",
				workflowId: "abc",
				epicId: null,
				targetRoute: "/workflow/abc",
			});
			if (!r) throw new Error("emit returned null");

			const broadcasted: ServerMessage[] = [];
			const clientRoutes = new Map<ServerWebSocket<WsData>, string>();
			const { markAlertsSeenWhere } = createAlertBroadcasters(
				queue,
				(m) => broadcasted.push(m),
				() => clientRoutes.values(),
			);
			const deps = {
				alertQueue: queue,
				broadcast: () => {},
				sendTo: () => {},
				clientRoutes,
				markAlertsSeenWhere,
			} as unknown as HandlerDeps;
			const fakeWs = {} as ServerWebSocket<WsData>;

			await handleAlertRouteChanged(
				fakeWs,
				{ type: "alert:route-changed", path: "/workflow/abc/" },
				deps,
			);

			expect(clientRoutes.get(fakeWs)).toBe("/workflow/abc");
			expect(broadcasted).toHaveLength(1);
			expect(queue.list()[0].seen).toBe(true);
		});
	});

	test("preserves root path `/` (no over-normalization)", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir), { dedupWindowMs: 0 });
			const broadcasted: ServerMessage[] = [];
			const clientRoutes = new Map<ServerWebSocket<WsData>, string>();
			const { markAlertsSeenWhere } = createAlertBroadcasters(
				queue,
				(m) => broadcasted.push(m),
				() => clientRoutes.values(),
			);
			const deps = {
				alertQueue: queue,
				broadcast: () => {},
				sendTo: () => {},
				clientRoutes,
				markAlertsSeenWhere,
			} as unknown as HandlerDeps;
			const fakeWs = {} as ServerWebSocket<WsData>;

			await handleAlertRouteChanged(fakeWs, { type: "alert:route-changed", path: "/" }, deps);

			expect(clientRoutes.get(fakeWs)).toBe("/");
		});
	});

	test("empty-path short-circuits: clientRoutes stays empty and nothing is broadcast", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir), { dedupWindowMs: 0 });
			queue.emit({
				type: "workflow-finished",
				title: "Done",
				description: "",
				workflowId: "wf-z",
				epicId: null,
				targetRoute: "",
			});

			const broadcasted: ServerMessage[] = [];
			const clientRoutes = new Map<ServerWebSocket<WsData>, string>();
			const { markAlertsSeenWhere } = createAlertBroadcasters(
				queue,
				(m) => broadcasted.push(m),
				() => clientRoutes.values(),
			);
			const deps = {
				alertQueue: queue,
				broadcast: () => {},
				sendTo: () => {},
				clientRoutes,
				markAlertsSeenWhere,
			} as unknown as HandlerDeps;
			const fakeWs = {} as ServerWebSocket<WsData>;

			await handleAlertRouteChanged(fakeWs, { type: "alert:route-changed", path: "" }, deps);

			expect(clientRoutes.size).toBe(0);
			expect(broadcasted).toHaveLength(0);
			expect(queue.list()[0].seen).toBe(false);
		});
	});
});

describe("clearClientRouteOnClose", () => {
	test("removes the disconnected ws from clientRoutes (FR-007: no stale paths)", () => {
		const clientRoutes = new Map<ServerWebSocket<WsData>, string>();
		const wsA = {} as ServerWebSocket<WsData>;
		const wsB = {} as ServerWebSocket<WsData>;
		clientRoutes.set(wsA, "/workflow/a");
		clientRoutes.set(wsB, "/workflow/b");

		clearClientRouteOnClose(wsA, clientRoutes);

		expect(clientRoutes.has(wsA)).toBe(false);
		expect(clientRoutes.get(wsB)).toBe("/workflow/b");
	});

	test("no-op when ws was never registered", () => {
		const clientRoutes = new Map<ServerWebSocket<WsData>, string>();
		const ws = {} as ServerWebSocket<WsData>;
		clearClientRouteOnClose(ws, clientRoutes);
		expect(clientRoutes.size).toBe(0);
	});
});

describe("handleAlertDismiss", () => {
	test("removes the alert and broadcasts alert:dismissed", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir), { dedupWindowMs: 0 });
			const h = makeHarness(queue);
			const r = queue.emit(makeInput({ workflowId: "wf-y" }));
			const id = r?.alert.id ?? "";
			await handleAlertDismiss({} as never, { type: "alert:dismiss", alertId: id }, h.deps);
			expect(queue.list()).toHaveLength(0);
			expect(h.broadcasted).toHaveLength(1);
			const m = h.broadcasted[0];
			if (m.type !== "alert:dismissed") throw new Error("expected alert:dismissed");
			expect(m.alertIds).toEqual([id]);
			expect(h.sentTo).toHaveLength(0);
		});
	});

	test("still works after clear-all (registry intact): emit → clearAll → emit → dismiss", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir), { dedupWindowMs: 0 });
			const h = makeHarness(queue);
			queue.emit(makeInput({ workflowId: "wf-before-clear" }));
			await handleAlertClearAll({} as never, { type: "alert:clear-all" }, h.deps);
			expect(queue.list()).toHaveLength(0);

			const r = queue.emit(makeInput({ workflowId: "wf-after-clear" }));
			const id = r?.alert.id ?? "";
			await handleAlertDismiss({} as never, { type: "alert:dismiss", alertId: id }, h.deps);
			expect(queue.list()).toHaveLength(0);
			const lastBroadcast = h.broadcasted.at(-1);
			if (!lastBroadcast || lastBroadcast.type !== "alert:dismissed") {
				throw new Error("expected alert:dismissed");
			}
			expect(lastBroadcast.alertIds).toEqual([id]);
		});
	});

	test("unknown alertId: sends one error back to caller and does not broadcast", async () => {
		await withTempDir(async (dir) => {
			const queue = new AlertQueue(new AlertStore(dir), { dedupWindowMs: 0 });
			const r = queue.emit(makeInput({ workflowId: "wf-live" }));
			expect(r).not.toBeNull();
			const initialLen = queue.list().length;

			const h = makeHarness(queue);
			await handleAlertDismiss(
				{} as never,
				{ type: "alert:dismiss", alertId: "does-not-exist" },
				h.deps,
			);

			expect(h.broadcasted).toHaveLength(0);
			expect(h.sentTo).toHaveLength(1);
			const err = h.sentTo[0];
			if (err.type !== "error") throw new Error("expected error envelope");
			expect(err.message).toMatch(/Unknown alertId: does-not-exist/);
			expect(queue.list()).toHaveLength(initialLen);
		});
	});
});
