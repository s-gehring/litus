import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpicStore } from "../../src/epic-store";
import { makePersistedEpic, resetEpicCounter } from "../test-infra/factories";

describe("EpicStore: archive-fields migration and round-trip", () => {
	let baseDir: string;
	let store: EpicStore;

	beforeEach(() => {
		resetEpicCounter();
		baseDir = join(
			tmpdir(),
			`epic-store-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(baseDir, { recursive: true });
		store = new EpicStore(baseDir);
	});

	afterEach(() => {
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {}
	});

	test("pre-migration epics.json loads with archive defaults", async () => {
		const legacy = [
			{
				epicId: "e1",
				description: "d",
				status: "completed",
				title: "t",
				workflowIds: [],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				errorMessage: null,
				infeasibleNotes: null,
				analysisSummary: null,
			},
		];
		writeFileSync(join(baseDir, "epics.json"), JSON.stringify(legacy, null, 2));

		const all = await store.loadAll();
		expect(all).toHaveLength(1);
		expect(all[0].archived).toBe(false);
		expect(all[0].archivedAt).toBeNull();
	});

	test("dropAnalyzing removes epics with status='analyzing' and keeps the rest", async () => {
		const analyzing = makePersistedEpic({ status: "analyzing" });
		const completed = makePersistedEpic({ status: "completed" });
		await store.save(analyzing);
		await store.save(completed);

		const dropped = await store.dropAnalyzing();
		expect(dropped).toBe(1);

		const all = await store.loadAll();
		expect(all).toHaveLength(1);
		expect(all[0].epicId).toBe(completed.epicId);
	});

	test("dropAnalyzing is a no-op when no analyzing epics exist", async () => {
		const completed = makePersistedEpic({ status: "completed" });
		await store.save(completed);

		const dropped = await store.dropAnalyzing();
		expect(dropped).toBe(0);

		const all = await store.loadAll();
		expect(all).toHaveLength(1);
	});

	test("archived epic round-trips through save and reload", async () => {
		const iso = "2026-04-22T12:00:00.000Z";
		const epic = makePersistedEpic({ archived: true, archivedAt: iso });
		await store.save(epic);

		const all = await store.loadAll();
		expect(all).toHaveLength(1);
		expect(all[0].archived).toBe(true);
		expect(all[0].archivedAt).toBe(iso);
	});
});
