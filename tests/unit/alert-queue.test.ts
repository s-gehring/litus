import { describe, expect, test } from "bun:test";
import { AlertQueue } from "../../src/alert-queue";
import { AlertStore } from "../../src/alert-store";
import { withTempDir } from "../test-infra";

function fakeClock(start = 1_000_000) {
	let t = start;
	return {
		advance: (ms: number) => {
			t += ms;
		},
		set: (v: number) => {
			t = v;
		},
		now: () => t,
	};
}

function makeInput(
	over: Partial<{
		type: "question-asked" | "error" | "workflow-finished" | "pr-opened-manual" | "epic-finished";
		workflowId: string | null;
		epicId: string | null;
	}> = {},
) {
	return {
		type: over.type ?? ("question-asked" as const),
		title: "t",
		description: "d",
		workflowId: over.workflowId === undefined ? "wf1" : over.workflowId,
		epicId: over.epicId === undefined ? null : over.epicId,
		targetRoute: "/workflow/wf1",
	};
}

describe("AlertQueue", () => {
	test("emit → list reflects it, persists to disk", async () => {
		await withTempDir(async (dir) => {
			const clock = fakeClock();
			const store = new AlertStore(dir);
			const q = new AlertQueue(store, { now: clock.now });
			const result = q.emit(makeInput());
			expect(result?.alert.id).toMatch(/^alert_/);
			expect(result?.evictedId).toBeNull();
			expect(q.list()).toHaveLength(1);
			await q.flush();
			const reloaded = await store.load();
			expect(reloaded).toHaveLength(1);
		});
	});

	test("dedup: same (type, workflowId) suppressed within 5s window, passes after", async () => {
		await withTempDir(async (dir) => {
			const clock = fakeClock();
			const q = new AlertQueue(new AlertStore(dir), { now: clock.now });
			expect(q.emit(makeInput())).not.toBeNull();
			clock.advance(4_999);
			expect(q.emit(makeInput())).toBeNull();
			clock.advance(2);
			expect(q.emit(makeInput())).not.toBeNull();
			await q.flush();
		});
	});

	test("dedup keys differ by type and by workflow/epic id", async () => {
		await withTempDir(async (dir) => {
			const clock = fakeClock();
			const q = new AlertQueue(new AlertStore(dir), { now: clock.now });
			expect(q.emit(makeInput({ type: "error" }))).not.toBeNull();
			expect(q.emit(makeInput({ type: "question-asked" }))).not.toBeNull();
			expect(q.emit(makeInput({ workflowId: "wf2" }))).not.toBeNull();
			expect(
				q.emit(makeInput({ workflowId: null, epicId: "ep1", type: "epic-finished" })),
			).not.toBeNull();
			await q.flush();
		});
	});

	test("cap + oldest-eviction", async () => {
		await withTempDir(async (dir) => {
			const clock = fakeClock();
			const q = new AlertQueue(new AlertStore(dir), {
				now: clock.now,
				maxAlerts: 3,
				dedupWindowMs: 0,
			});
			for (let i = 0; i < 3; i++) {
				clock.advance(1);
				q.emit(makeInput({ workflowId: `wf${i}` }));
			}
			expect(q.list()).toHaveLength(3);
			const firstId = q.list()[2].id; // oldest = last in newest-first list
			clock.advance(1);
			const r = q.emit(makeInput({ workflowId: "wf3" }));
			expect(r?.evictedId).toBe(firstId);
			expect(q.list()).toHaveLength(3);
			expect(q.list().map((a) => a.workflowId)).toEqual(["wf3", "wf2", "wf1"]);
			await q.flush();
		});
	});

	test("dismiss by id", async () => {
		await withTempDir(async (dir) => {
			const clock = fakeClock();
			const q = new AlertQueue(new AlertStore(dir), { now: clock.now });
			const r = q.emit(makeInput());
			expect(q.dismiss(r?.alert.id ?? "")).toBe(true);
			expect(q.list()).toHaveLength(0);
			expect(q.dismiss("nope")).toBe(false);
			await q.flush();
		});
	});

	test("dismissWhere filters by type + workflowId", async () => {
		await withTempDir(async (dir) => {
			const clock = fakeClock();
			const q = new AlertQueue(new AlertStore(dir), {
				now: clock.now,
				dedupWindowMs: 0,
			});
			clock.advance(1);
			q.emit(makeInput({ type: "question-asked", workflowId: "wf1" }));
			clock.advance(1);
			q.emit(makeInput({ type: "question-asked", workflowId: "wf2" }));
			clock.advance(1);
			q.emit(makeInput({ type: "error", workflowId: "wf1" }));
			const removed = q.dismissWhere({ type: "question-asked", workflowId: "wf1" });
			expect(removed).toHaveLength(1);
			expect(q.list().map((a) => `${a.type}:${a.workflowId}`)).toEqual([
				"error:wf1",
				"question-asked:wf2",
			]);
			await q.flush();
		});
	});

	test("loadFromDisk restores sorted state + dedup map", async () => {
		await withTempDir(async (dir) => {
			const clock = fakeClock();
			const store = new AlertStore(dir);
			const q1 = new AlertQueue(store, { now: clock.now });
			clock.advance(1);
			q1.emit(makeInput({ workflowId: "wf1" }));
			clock.advance(1);
			q1.emit(makeInput({ workflowId: "wf2" }));
			await q1.flush();

			const q2 = new AlertQueue(new AlertStore(dir), { now: clock.now });
			await q2.loadFromDisk();
			expect(q2.list()).toHaveLength(2);
			// dedup map should suppress immediate duplicate of wf1 question-asked
			expect(q2.emit(makeInput({ workflowId: "wf1" }))).toBeNull();
			await q2.flush();
		});
	});

	test("title/description truncated to declared caps", () => {
		const clock = fakeClock();
		const q = new AlertQueue(new AlertStore("/tmp/litus-alert-truncate-test"), { now: clock.now });
		const longTitle = "t".repeat(200);
		const longDesc = "d".repeat(800);
		const r = q.emit({
			type: "error",
			title: longTitle,
			description: longDesc,
			workflowId: "wf",
			epicId: null,
			targetRoute: "/workflow/wf",
		});
		expect(r?.alert.title.length).toBe(120);
		expect(r?.alert.description.length).toBe(500);
	});

	test("clearAll drops every alert, resets dedup, persists empty list", async () => {
		await withTempDir(async (dir) => {
			const clock = fakeClock();
			const store = new AlertStore(dir);
			const q = new AlertQueue(store, { now: clock.now, dedupWindowMs: 0 });
			clock.advance(1);
			const a = q.emit(makeInput({ workflowId: "wf1" }));
			clock.advance(1);
			const b = q.emit(makeInput({ workflowId: "wf2" }));

			if (!a || !b) throw new Error("emit returned null");
			const cleared = q.clearAll();
			expect(new Set(cleared)).toEqual(new Set([a.alert.id, b.alert.id]));
			expect(q.list()).toHaveLength(0);

			await q.flush();
			expect(await store.load()).toEqual([]);

			// Dedup cleared: same (type, wf) emits again at the same instant.
			const reemit = q.emit(makeInput({ workflowId: "wf1" }));
			expect(reemit).not.toBeNull();
			await q.flush();
		});
	});

	test("clearAll on empty queue returns [] and still persists empty list", async () => {
		await withTempDir(async (dir) => {
			const clock = fakeClock();
			const store = new AlertStore(dir);
			const q = new AlertQueue(store, { now: clock.now });
			const cleared = q.clearAll();
			expect(cleared).toEqual([]);
			await q.flush();
			expect(await store.load()).toEqual([]);
		});
	});
});
