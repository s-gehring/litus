import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowIndexEntry } from "../src/types";
import { WorkflowStore } from "../src/workflow-store";
import { assertDefined, makeWorkflow } from "./helpers";

describe("WorkflowStore", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		baseDir = join(
			tmpdir(),
			`workflow-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		store = new WorkflowStore(baseDir);
	});

	afterEach(() => {
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	test("T004: atomic write uses write-to-tmp-then-rename", async () => {
		const workflow = makeWorkflow();
		await store.save(workflow);

		// The final file should exist
		const filePath = join(baseDir, `${workflow.id}.json`);
		expect(existsSync(filePath)).toBe(true);

		// No tmp files should remain (they are renamed to the final path)
		const tmpFiles = readdirSync(baseDir).filter((f) => f.endsWith(".tmp"));
		expect(tmpFiles).toHaveLength(0);

		// The content should be valid JSON
		const content = await Bun.file(filePath).text();
		const parsed = JSON.parse(content);
		expect(parsed.id).toBe(workflow.id);
	});

	test("T005: save and load single workflow round-trip", async () => {
		const workflow = makeWorkflow({
			id: "round-trip-1",
			specification: "Test round trip",
			status: "running",
		});
		workflow.steps[0].status = "completed";
		workflow.steps[0].output = "Step 1 output";
		workflow.steps[1].status = "running";
		workflow.steps[1].sessionId = "session-abc";
		workflow.steps[1].pid = 12345;

		await store.save(workflow);
		const loaded = await store.load("round-trip-1");

		assertDefined(loaded);
		expect(loaded.id).toBe("round-trip-1");
		expect(loaded.specification).toBe("Test round trip");
		expect(loaded.status).toBe("running");
		expect(loaded.steps[0].status).toBe("completed");
		expect(loaded.steps[0].output).toBe("Step 1 output");
		expect(loaded.steps[1].sessionId).toBe("session-abc");
		expect(loaded.steps[1].pid).toBe(12345);
	});

	test("T006: loadAll returns workflows sorted by updatedAt descending", async () => {
		const older = makeWorkflow({
			id: "older-1",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const newer = makeWorkflow({
			id: "newer-1",
			updatedAt: "2026-04-01T00:00:00.000Z",
		});
		const middle = makeWorkflow({
			id: "middle-1",
			updatedAt: "2026-02-15T00:00:00.000Z",
		});

		await store.save(older);
		await store.save(middle);
		await store.save(newer);

		const all = await store.loadAll();
		expect(all).toHaveLength(3);
		expect(all[0].id).toBe("newer-1");
		expect(all[1].id).toBe("middle-1");
		expect(all[2].id).toBe("older-1");
	});

	test("T007: load returns null for corrupted JSON file", async () => {
		mkdirSync(baseDir, { recursive: true });
		writeFileSync(join(baseDir, "corrupt-1.json"), "not valid json{{{");

		const result = await store.load("corrupt-1");
		expect(result).toBeNull();
	});

	test("load returns null for valid JSON with missing required fields", async () => {
		mkdirSync(baseDir, { recursive: true });
		writeFileSync(join(baseDir, "invalid-1.json"), JSON.stringify({ foo: "bar" }));

		const result = await store.load("invalid-1");
		expect(result).toBeNull();
	});

	test("load returns null for out-of-bounds currentStepIndex", async () => {
		const workflow = makeWorkflow({ id: "bad-index" });
		await store.save(workflow);

		// Manually corrupt currentStepIndex
		const filePath = join(baseDir, "bad-index.json");
		const data = JSON.parse(await Bun.file(filePath).text());
		data.currentStepIndex = 99;
		writeFileSync(filePath, JSON.stringify(data, null, 2));

		const result = await store.load("bad-index");
		expect(result).toBeNull();
	});

	test("T008: loadAll skips corrupted files and prunes orphaned index entries", async () => {
		const good = makeWorkflow({ id: "good-1" });
		await store.save(good);

		// Write a corrupted file and add it to index
		writeFileSync(join(baseDir, "corrupt-2.json"), "broken json!!!");
		const indexPath = join(baseDir, "index.json");
		const index: WorkflowIndexEntry[] = JSON.parse(await Bun.file(indexPath).text());
		index.push({
			id: "corrupt-2",
			branch: "test",
			status: "running",
			summary: "",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		writeFileSync(indexPath, JSON.stringify(index, null, 2));

		const all = await store.loadAll();
		expect(all).toHaveLength(1);
		expect(all[0].id).toBe("good-1");

		// Index should be pruned — corrupted entry removed
		const updatedIndex = await store.loadIndex();
		expect(updatedIndex).toHaveLength(1);
		expect(updatedIndex[0].id).toBe("good-1");
	});

	test("T009: save creates baseDir if missing", async () => {
		const nestedDir = join(baseDir, "deep", "nested", "dir");
		const nestedStore = new WorkflowStore(nestedDir);
		const workflow = makeWorkflow();

		await nestedStore.save(workflow);

		expect(existsSync(join(nestedDir, `${workflow.id}.json`))).toBe(true);
	});

	test("T010: remove deletes workflow file and index entry", async () => {
		const workflow = makeWorkflow({ id: "remove-me" });
		await store.save(workflow);

		// Verify it exists
		expect(await store.load("remove-me")).not.toBeNull();
		const indexBefore = await store.loadIndex();
		expect(indexBefore.some((e) => e.id === "remove-me")).toBe(true);

		await store.remove("remove-me");

		// File should be gone
		expect(existsSync(join(baseDir, "remove-me.json"))).toBe(false);
		// Index entry should be gone
		const indexAfter = await store.loadIndex();
		expect(indexAfter.some((e) => e.id === "remove-me")).toBe(false);
	});

	test("T011: loadIndex rebuilds from scanning *.json when index.json is missing", async () => {
		const w1 = makeWorkflow({ id: "scan-1", updatedAt: "2026-01-01T00:00:00.000Z" });
		const w2 = makeWorkflow({ id: "scan-2", updatedAt: "2026-02-01T00:00:00.000Z" });
		await store.save(w1);
		await store.save(w2);

		// Delete the index file
		const indexPath = join(baseDir, "index.json");
		rmSync(indexPath);
		expect(existsSync(indexPath)).toBe(false);

		// loadIndex should rebuild by scanning
		const index = await store.loadIndex();
		expect(index).toHaveLength(2);
		const ids = index.map((e) => e.id).sort();
		expect(ids).toEqual(["scan-1", "scan-2"]);
	});
});
