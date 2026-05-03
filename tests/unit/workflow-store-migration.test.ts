import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowStore } from "../../src/workflow-store";
import { makeWorkflow } from "../helpers";

describe("WorkflowStore: history migration on load", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		baseDir = join(
			tmpdir(),
			`workflow-store-history-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(baseDir, { recursive: true });
		store = new WorkflowStore(baseDir);
	});

	afterEach(() => {
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {}
	});

	test("legacy workflow with aspects but missing output/outputLog backfills both fields", async () => {
		const workflow = makeWorkflow({ id: "legacy-aspects" });
		const persisted = JSON.parse(JSON.stringify(workflow));
		// Synthesise the pre-parallel-research persisted shape: aspects present
		// but without `output` / `outputLog` fields.
		persisted.aspectManifest = {
			version: 1,
			aspects: [
				{ id: "a", title: "A", researchPrompt: "p", fileName: "a.md" },
				{ id: "b", title: "B", researchPrompt: "p", fileName: "b.md" },
			],
		};
		persisted.aspects = [
			{
				id: "a",
				fileName: "a.md",
				status: "completed",
				sessionId: null,
				startedAt: "2026-05-03T00:00:00Z",
				completedAt: "2026-05-03T00:01:00Z",
				errorMessage: null,
			},
			{
				id: "b",
				fileName: "b.md",
				status: "pending",
				sessionId: null,
				startedAt: null,
				completedAt: null,
				errorMessage: null,
			},
		];
		writeFileSync(
			join(baseDir, "legacy-aspects.json"),
			JSON.stringify(persisted, null, 2),
		);

		const loaded = await store.load("legacy-aspects");
		if (!loaded) throw new Error("expected workflow to load");
		expect(loaded.aspects).not.toBeNull();
		for (const aspect of loaded.aspects ?? []) {
			expect(typeof aspect.output).toBe("string");
			expect(aspect.output).toBe("");
			expect(Array.isArray(aspect.outputLog)).toBe(true);
			expect(aspect.outputLog).toHaveLength(0);
		}
	});

	test("aspect output/outputLog backfill is idempotent — already-migrated data unchanged", async () => {
		const workflow = makeWorkflow({ id: "already-migrated" });
		const persisted = JSON.parse(JSON.stringify(workflow));
		persisted.aspectManifest = {
			version: 1,
			aspects: [{ id: "a", title: "A", researchPrompt: "p", fileName: "a.md" }],
		};
		persisted.aspects = [
			{
				id: "a",
				fileName: "a.md",
				status: "completed",
				sessionId: null,
				startedAt: "2026-05-03T00:00:00Z",
				completedAt: "2026-05-03T00:01:00Z",
				errorMessage: null,
				output: "preserved text",
				outputLog: [{ kind: "text", text: "preserved text" }],
			},
		];
		writeFileSync(
			join(baseDir, "already-migrated.json"),
			JSON.stringify(persisted, null, 2),
		);

		const loaded = await store.load("already-migrated");
		if (!loaded) throw new Error("expected workflow to load");
		const aspect = loaded.aspects?.[0];
		expect(aspect?.output).toBe("preserved text");
		expect(aspect?.outputLog).toHaveLength(1);
	});

	test("legacy workflow without step.history loads with history defaulted to []", async () => {
		const workflow = makeWorkflow({ id: "legacy-1" });
		// Simulate pre-feature persisted shape: strip history off every step
		const persisted = JSON.parse(JSON.stringify(workflow));
		for (const step of persisted.steps) {
			delete step.history;
		}
		writeFileSync(join(baseDir, "legacy-1.json"), JSON.stringify(persisted, null, 2));

		const loaded = await store.load("legacy-1");
		if (!loaded) throw new Error("expected workflow to load");
		for (const step of loaded.steps) {
			expect(Array.isArray(step.history)).toBe(true);
			expect(step.history).toHaveLength(0);
		}
	});

	test("legacy status 'cancelled' is migrated to 'aborted' on load", async () => {
		// Pre-rename workflows on disk carry status: "cancelled". The rename to
		// "aborted" needs to be transparent to the user — load() normalises the
		// value so all downstream code only ever sees "aborted". Without this,
		// existing workflows would break the narrow WorkflowStatus type.
		const workflow = makeWorkflow({ id: "legacy-cancelled" });
		const persisted = JSON.parse(JSON.stringify(workflow));
		persisted.status = "cancelled";
		writeFileSync(join(baseDir, "legacy-cancelled.json"), JSON.stringify(persisted, null, 2));

		const loaded = await store.load("legacy-cancelled");
		if (!loaded) throw new Error("expected workflow to load");
		expect(loaded.status).toBe("aborted");
	});

	test("legacy feedback outcome 'cancelled' is migrated to 'aborted' on load", async () => {
		// Same rename applies to FeedbackOutcomeValue. Feedback iterations that
		// were aborted by the user (or recovered as cancelled at restart) were
		// persisted with outcome.value: "cancelled". Normalise on load.
		const workflow = makeWorkflow({ id: "legacy-fe-cancelled" });
		const persisted = JSON.parse(JSON.stringify(workflow));
		persisted.feedbackEntries = [
			{
				id: "fe-1",
				iteration: 1,
				text: "do the thing",
				submittedAt: "2026-04-18T00:00:00.000Z",
				submittedAtStepName: "merge-pr",
				outcome: {
					value: "cancelled",
					summary: "Cancelled by user abort",
					commitRefs: [],
					warnings: [],
				},
			},
		];
		writeFileSync(join(baseDir, "legacy-fe-cancelled.json"), JSON.stringify(persisted, null, 2));

		const loaded = await store.load("legacy-fe-cancelled");
		if (!loaded) throw new Error("expected workflow to load");
		expect(loaded.feedbackEntries[0].outcome?.value).toBe("aborted");
	});

	test("history field round-trips through save + load", async () => {
		const workflow = makeWorkflow({ id: "round-trip-history" });
		workflow.steps[0].history = [
			{
				runNumber: 1,
				status: "completed",
				output: "prior run output",
				outputLog: [{ kind: "text", text: "prior run output" }],
				error: null,
				startedAt: "2026-04-18T10:00:00.000Z",
				completedAt: "2026-04-18T10:01:00.000Z",
			},
		];
		await store.save(workflow);
		const loaded = await store.load("round-trip-history");
		if (!loaded) throw new Error("expected workflow to load");
		expect(loaded.steps[0].history).toHaveLength(1);
		expect(loaded.steps[0].history[0].output).toBe("prior run output");
		expect(loaded.steps[0].history[0].runNumber).toBe(1);
	});
});
