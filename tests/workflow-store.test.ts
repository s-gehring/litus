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

	test("T008: loadAll skips corrupted files but keeps the index entry for recovery", async () => {
		const good = makeWorkflow({ id: "good-1" });
		await store.save(good);

		// Write a corrupted file and add it to index. A corrupt-but-present
		// file may be a transient artefact (Windows rename race, antivirus
		// hold, mid-write observation) — pruning the index permanently strands
		// the workflow from the UI even though the file is still on disk.
		writeFileSync(join(baseDir, "corrupt-2.json"), "broken json!!!");
		const indexPath = join(baseDir, "index.json");
		const index: WorkflowIndexEntry[] = JSON.parse(await Bun.file(indexPath).text());
		index.push({
			id: "corrupt-2",
			workflowKind: "spec",
			branch: "test",
			status: "running",
			summary: "",
			epicId: null,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			archived: false,
			archivedAt: null,
		});
		writeFileSync(indexPath, JSON.stringify(index, null, 2));

		const all = await store.loadAll();
		expect(all).toHaveLength(1);
		expect(all[0].id).toBe("good-1");

		// Index entry for the corrupt-but-present file is preserved so a
		// later load attempt (after the transient condition clears) can
		// surface the workflow again.
		const updatedIndex = await store.loadIndex();
		const ids = updatedIndex.map((e) => e.id).sort();
		expect(ids).toEqual(["corrupt-2", "good-1"]);
	});

	test("loadAll prunes index entries whose .json file is missing", async () => {
		const good = makeWorkflow({ id: "present" });
		await store.save(good);

		// Inject an index entry that points to a workflow file that does not
		// exist on disk. This is the only condition that should trigger an
		// index prune.
		const indexPath = join(baseDir, "index.json");
		const index: WorkflowIndexEntry[] = JSON.parse(await Bun.file(indexPath).text());
		index.push({
			id: "ghost",
			workflowKind: "spec",
			branch: "test",
			status: "running",
			summary: "",
			epicId: null,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			archived: false,
			archivedAt: null,
		});
		writeFileSync(indexPath, JSON.stringify(index, null, 2));

		const all = await store.loadAll();
		expect(all).toHaveLength(1);
		expect(all[0].id).toBe("present");

		const updatedIndex = await store.loadIndex();
		expect(updatedIndex).toHaveLength(1);
		expect(updatedIndex[0].id).toBe("present");
	});

	test("transient load failure does not strand the workflow once it recovers", async () => {
		// Repro for the "specs vanish after a sibling errored" bug: a transient
		// read failure during heavy concurrent writes used to prune the index
		// entry permanently. With the fix, the entry survives so the next
		// loadAll re-surfaces the workflow once the file is readable again.
		const wf = makeWorkflow({ id: "transient-1" });
		await store.save(wf);

		const filePath = join(baseDir, "transient-1.json");
		const goodContent = await Bun.file(filePath).text();

		// Simulate a transient mid-rename observation: the file briefly
		// contains junk that fails JSON.parse.
		writeFileSync(filePath, "<<garbled>>");

		const firstPass = await store.loadAll();
		expect(firstPass.map((w) => w.id)).toEqual([]);

		// Index entry must still be there — that is the regression guard.
		const indexAfterFailedLoad = await store.loadIndex();
		expect(indexAfterFailedLoad.map((e) => e.id)).toEqual(["transient-1"]);

		// Restore the file (transient condition clears) and reload.
		writeFileSync(filePath, goodContent);

		const secondPass = await store.loadAll();
		expect(secondPass.map((w) => w.id)).toEqual(["transient-1"]);
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

	test("feedback entries round-trip through save + load", async () => {
		const workflow = makeWorkflow({ id: "fb-round-trip" });
		workflow.feedbackEntries = [
			{
				id: "fe-1",
				iteration: 1,
				text: "rename x to count",
				submittedAt: "2026-04-13T14:22:01.000Z",
				submittedAtStepName: "merge-pr",
				outcome: {
					value: "success",
					summary: "renamed x to count",
					commitRefs: ["abc1234"],
					warnings: [],
				},
			},
			{
				id: "fe-2",
				iteration: 2,
				text: "also update the test file",
				submittedAt: "2026-04-13T14:40:00.000Z",
				submittedAtStepName: "merge-pr",
				outcome: null,
			},
		];

		await store.save(workflow);
		const loaded = await store.load("fb-round-trip");

		assertDefined(loaded);
		expect(loaded.feedbackEntries).toHaveLength(2);
		expect(loaded.feedbackEntries[0].iteration).toBe(1);
		expect(loaded.feedbackEntries[0].outcome?.value).toBe("success");
		expect(loaded.feedbackEntries[0].outcome?.commitRefs).toEqual(["abc1234"]);
		expect(loaded.feedbackEntries[1].outcome).toBeNull();
	});

	describe("hasEverStarted migration backfill (F3 / FR-003)", () => {
		const statusExpectations: Array<{ status: string; expected: boolean }> = [
			{ status: "idle", expected: false },
			{ status: "waiting_for_dependencies", expected: false },
			{ status: "running", expected: true },
			{ status: "paused", expected: true },
			{ status: "waiting_for_input", expected: true },
			{ status: "completed", expected: true },
			{ status: "error", expected: true },
			{ status: "aborted", expected: true },
		];

		for (const { status, expected } of statusExpectations) {
			test(`status=${status} → hasEverStarted=${expected}`, async () => {
				mkdirSync(baseDir, { recursive: true });
				const wf = makeWorkflow({ id: `legacy-${status}` });
				wf.status = status as typeof wf.status;
				const raw = JSON.parse(JSON.stringify(wf)) as Record<string, unknown>;
				delete raw.hasEverStarted;
				writeFileSync(join(baseDir, `legacy-${status}.json`), JSON.stringify(raw, null, 2));

				const loaded = await store.load(`legacy-${status}`);
				assertDefined(loaded);
				expect(loaded.hasEverStarted).toBe(expected);
			});
		}
	});

	test("migration backfills feedbackEntries = [] for legacy workflows", async () => {
		mkdirSync(baseDir, { recursive: true });
		const legacy = makeWorkflow({ id: "legacy-no-feedback" });
		// Simulate a persisted workflow from before this feature — drop the field
		const legacyRaw = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
		delete legacyRaw.feedbackEntries;
		writeFileSync(join(baseDir, "legacy-no-feedback.json"), JSON.stringify(legacyRaw, null, 2));

		const loaded = await store.load("legacy-no-feedback");

		assertDefined(loaded);
		expect(loaded.feedbackEntries).toEqual([]);
	});

	test("migration backfills feedbackPreRunHead = null for legacy workflows", async () => {
		mkdirSync(baseDir, { recursive: true });
		const legacy = makeWorkflow({ id: "legacy-no-prerunhead" });
		const legacyRaw = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
		delete legacyRaw.feedbackPreRunHead;
		writeFileSync(join(baseDir, "legacy-no-prerunhead.json"), JSON.stringify(legacyRaw, null, 2));

		const loaded = await store.load("legacy-no-prerunhead");

		assertDefined(loaded);
		expect(loaded.feedbackPreRunHead).toBeNull();
	});

	test("feedbackPreRunHead survives save + load round-trip", async () => {
		const workflow = makeWorkflow({ id: "prerunhead-round-trip" });
		workflow.feedbackPreRunHead = "abc1234deadbeef";
		await store.save(workflow);

		const loaded = await store.load("prerunhead-round-trip");
		assertDefined(loaded);
		expect(loaded.feedbackPreRunHead).toBe("abc1234deadbeef");
	});

	test("identity + epic-linkage preserved across reset + persist + reload", async () => {
		// FR-006: "workflow's stable identifier and any association with a
		// parent epic" must survive a reset. Prove this across a full persist
		// round-trip: save an epic-linked workflow, mutate it as resetWorkflow
		// would (cleared per-step state, back to idle), save + reload, and
		// assert id and epicId round-trip unchanged.
		const { resetWorkflow } = await import("../src/workflow-engine");

		// Mock Bun.spawn for the git worktree/branch calls.
		const originalSpawn = Bun.spawn;
		const BunGlobal = globalThis as unknown as { Bun: { spawn: unknown } };
		BunGlobal.Bun.spawn = (() => ({
			exited: Promise.resolve(0),
			stdout: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			stderr: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
		})) as unknown;

		try {
			const wf = makeWorkflow({
				id: "linked-wf",
				status: "error",
				epicId: "epic-123",
				worktreePath: null,
				worktreeBranch: "tmp-linked",
				targetRepository: "/tmp/repo",
			});
			await store.save(wf);

			await resetWorkflow(wf);
			await store.save(wf);

			const reloaded = await store.load("linked-wf");
			assertDefined(reloaded);
			expect(reloaded.id).toBe("linked-wf");
			expect(reloaded.epicId).toBe("epic-123");
			expect(reloaded.status).toBe("idle");

			// FR-006 other half: the epic's `workflowIds` list must still
			// resolve to the reset workflow's id. Save an epic record and
			// assert the linkage survives the reset round-trip.
			const { EpicStore } = await import("../src/epic-store");
			const epicStore = new EpicStore(baseDir);
			await epicStore.save({
				epicId: "epic-123",
				description: "epic for linkage test",
				status: "completed",
				title: "Linkage",
				workflowIds: ["linked-wf"],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				errorMessage: null,
				infeasibleNotes: null,
				analysisSummary: null,
				decompositionSessionId: null,
				feedbackHistory: [],
				sessionContextLost: false,
				attemptCount: 1,
				archived: false,
				archivedAt: null,
			});
			// Re-reset + re-save to prove the epic's linkage is orthogonal to
			// the workflow reset cycle.
			await resetWorkflow(wf);
			await store.save(wf);

			const epics = await epicStore.loadAll();
			const epic = epics.find((e) => e.epicId === "epic-123");
			assertDefined(epic);
			expect(epic.workflowIds).toContain("linked-wf");
		} finally {
			BunGlobal.Bun.spawn = originalSpawn;
		}
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

	describe("workflowKind back-compat migration (FR-012)", () => {
		test("loading a per-workflow file with no workflowKind defaults to 'spec'", async () => {
			const wf = makeWorkflow({ id: "legacy-1" });
			await store.save(wf);
			const filePath = join(baseDir, `${wf.id}.json`);
			const raw = JSON.parse(await Bun.file(filePath).text());
			// Simulate a pre-quick-fix on-disk shape: strip workflowKind entirely
			delete raw.workflowKind;
			writeFileSync(filePath, JSON.stringify(raw, null, 2));

			const loaded = await store.load(wf.id);
			assertDefined(loaded);
			expect(loaded.workflowKind).toBe("spec");
		});

		test("loading an index entry with no workflowKind normalizes to 'spec'", async () => {
			const wf = makeWorkflow({ id: "legacy-2" });
			await store.save(wf);
			// Rewrite the index so the entry has no workflowKind field
			const indexPath = join(baseDir, "index.json");
			const entries: Array<Partial<WorkflowIndexEntry>> = JSON.parse(
				await Bun.file(indexPath).text(),
			);
			for (const e of entries) delete (e as Record<string, unknown>).workflowKind;
			writeFileSync(indexPath, JSON.stringify(entries, null, 2));

			const loadedIndex = await store.loadIndex();
			expect(loadedIndex[0].workflowKind).toBe("spec");
		});

		test("loading then saving persists the defaulted workflowKind on disk", async () => {
			const wf = makeWorkflow({ id: "legacy-3" });
			await store.save(wf);
			const filePath = join(baseDir, `${wf.id}.json`);
			const raw = JSON.parse(await Bun.file(filePath).text());
			delete raw.workflowKind;
			writeFileSync(filePath, JSON.stringify(raw, null, 2));

			const loaded = await store.load(wf.id);
			assertDefined(loaded);
			await store.save(loaded);

			const roundTripped = JSON.parse(await Bun.file(filePath).text());
			expect(roundTripped.workflowKind).toBe("spec");
		});

		test("round-trips a workflowKind: 'quick-fix' workflow", async () => {
			const wf = makeWorkflow({ id: "qf-1" });
			wf.workflowKind = "quick-fix";
			await store.save(wf);
			const loaded = await store.load(wf.id);
			assertDefined(loaded);
			expect(loaded.workflowKind).toBe("quick-fix");

			const index = await store.loadIndex();
			const entry = index.find((e) => e.id === "qf-1");
			assertDefined(entry);
			expect(entry.workflowKind).toBe("quick-fix");
		});
	});
});
