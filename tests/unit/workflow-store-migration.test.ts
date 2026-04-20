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
