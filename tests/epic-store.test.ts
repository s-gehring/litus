import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpicStore } from "../src/epic-store";
import type { PersistedEpic } from "../src/types";

function makeEpic(overrides?: Partial<PersistedEpic>): PersistedEpic {
	return {
		epicId: `e-${Date.now()}`,
		description: "Test epic",
		status: "completed",
		title: "Test",
		workflowIds: [],
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		errorMessage: null,
		infeasibleNotes: null,
		analysisSummary: null,
		...overrides,
	};
}

describe("EpicStore", () => {
	let baseDir: string;
	let store: EpicStore;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "epic-store-test-"));
		store = new EpicStore(baseDir);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	test("loadAll returns empty array when no file exists", async () => {
		const result = await store.loadAll();
		expect(result).toEqual([]);
	});

	test("loadAll returns empty array and logs warning on corrupted JSON", async () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

		mkdirSync(baseDir, { recursive: true });
		writeFileSync(join(baseDir, "epics.json"), "not valid json{{{");

		const result = await store.loadAll();
		expect(result).toEqual([]);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining("[epic-store] Failed to load epics:"),
			expect.anything(),
		);

		warnSpy.mockRestore();
	});

	test("loadAll returns empty array without warning when data is not an array", async () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

		mkdirSync(baseDir, { recursive: true });
		writeFileSync(join(baseDir, "epics.json"), JSON.stringify({ not: "an array" }));

		const result = await store.loadAll();
		expect(result).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test("save and loadAll round-trip", async () => {
		const epic = makeEpic({ epicId: "e-1" });

		await store.save(epic);
		const result = await store.loadAll();

		expect(result).toHaveLength(1);
		expect(result[0].epicId).toBe("e-1");
	});

	test("removeAll deletes the epics file", async () => {
		const epic = makeEpic({ epicId: "e-2", description: "To be removed" });

		await store.save(epic);
		expect((await store.loadAll()).length).toBe(1);

		await store.removeAll();
		expect(await store.loadAll()).toEqual([]);
	});
});
