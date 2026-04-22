import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowIndexEntry } from "../../src/types";
import { WorkflowStore } from "../../src/workflow-store";
import { makeWorkflow } from "../helpers";

describe("WorkflowStore: archive-fields migration and round-trip", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		baseDir = join(
			tmpdir(),
			`workflow-store-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(baseDir, { recursive: true });
		store = new WorkflowStore(baseDir);
	});

	afterEach(() => {
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {}
	});

	test("pre-migration workflow without archive fields loads with defaults", async () => {
		const wf = makeWorkflow({ id: "legacy-arc" });
		const persisted = JSON.parse(JSON.stringify(wf));
		delete persisted.archived;
		delete persisted.archivedAt;
		writeFileSync(join(baseDir, "legacy-arc.json"), JSON.stringify(persisted, null, 2));

		const loaded = await store.load("legacy-arc");
		if (!loaded) throw new Error("expected workflow to load");
		expect(loaded.archived).toBe(false);
		expect(loaded.archivedAt).toBeNull();
	});

	test("archived workflow round-trips through save and reload", async () => {
		const iso = "2026-04-22T12:00:00.000Z";
		const wf = makeWorkflow({ id: "arc-1", archived: true, archivedAt: iso });
		await store.save(wf);

		const loaded = await store.load("arc-1");
		if (!loaded) throw new Error("expected workflow to load");
		expect(loaded.archived).toBe(true);
		expect(loaded.archivedAt).toBe(iso);
	});

	test("index.json carries archived and archivedAt after save", async () => {
		const iso = "2026-04-22T12:00:00.000Z";
		const wf = makeWorkflow({ id: "arc-2", archived: true, archivedAt: iso });
		await store.save(wf);

		const index = await store.loadIndex();
		const entry = index.find((e: WorkflowIndexEntry) => e.id === "arc-2");
		if (!entry) throw new Error("expected index entry");
		expect(entry.archived).toBe(true);
		expect(entry.archivedAt).toBe(iso);
	});

	test("pre-migration index entry defaults archive fields on load", async () => {
		const legacy = [
			{
				id: "legacy-idx",
				workflowKind: "spec",
				branch: "tmp-x",
				status: "completed",
				summary: "s",
				epicId: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		];
		writeFileSync(join(baseDir, "index.json"), JSON.stringify(legacy, null, 2));

		const index = await store.loadIndex();
		const e = index.find((x) => x.id === "legacy-idx");
		if (!e) throw new Error("expected entry");
		expect(e.archived).toBe(false);
		expect(e.archivedAt).toBeNull();
	});
});
