import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workflow } from "../src/types";
import { WorkflowStore } from "../src/workflow-store";

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
	return {
		id: "test-id-1",
		specification: "test spec",
		status: "completed",
		targetRepository: "/tmp/test-repo",
		worktreePath: "/tmp/test-worktree",
		worktreeBranch: "tmp-test0001",
		featureBranch: null,
		summary: "test",
		stepSummary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: [
			{
				name: "specify",
				displayName: "Specifying",
				status: "completed",
				prompt: "/speckit-specify test",
				sessionId: null,
				output: "",
				outputLog: [],
				error: null,
				startedAt: null,
				completedAt: null,
				pid: null,
				history: [],
			},
		],
		currentStepIndex: 0,
		reviewCycle: { iteration: 1, maxIterations: 16, lastSeverity: null },
		ciCycle: {
			attempt: 0,
			maxAttempts: 3,
			monitorStartedAt: null,
			globalTimeoutMs: 30 * 60 * 1000,
			lastCheckResults: [],
			failureLogs: [],
		},
		mergeCycle: {
			attempt: 0,
			maxAttempts: 3,
		},
		prUrl: null,
		epicId: null,
		epicTitle: null,
		epicDependencies: [],
		epicDependencyStatus: null,
		epicAnalysisMs: 0,
		activeWorkMs: 0,
		activeWorkStartedAt: null,
		feedbackEntries: [],
		feedbackPreRunHead: null,
		activeInvocation: null,
		managedRepo: null,
		error: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("PR URL persistence", () => {
	let tmpDir: string;
	let store: WorkflowStore;

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	function setup() {
		tmpDir = mkdtempSync(join(tmpdir(), "crab-test-"));
		store = new WorkflowStore(tmpDir);
	}

	test("round-trip: save workflow with prUrl, reload, verify prUrl present", async () => {
		setup();
		const workflow = makeWorkflow({ prUrl: "https://github.com/owner/repo/pull/42" });
		await store.save(workflow);
		const loaded = await store.load(workflow.id);
		expect(loaded).not.toBeNull();
		expect(loaded?.prUrl).toBe("https://github.com/owner/repo/pull/42");
	});

	test("round-trip: save workflow with null prUrl, reload, verify null", async () => {
		setup();
		const workflow = makeWorkflow({ prUrl: null });
		await store.save(workflow);
		const loaded = await store.load(workflow.id);
		expect(loaded).not.toBeNull();
		expect(loaded?.prUrl).toBeNull();
	});

	test("backward compat: load legacy workflow without prUrl field", async () => {
		setup();
		// Write a JSON file missing the prUrl field (simulating legacy data)
		const workflow = makeWorkflow();
		const data = JSON.stringify(workflow, null, 2);
		const withoutPrUrl = data.replace(/\s*"prUrl":\s*null,?\n?/, "\n");
		await Bun.write(join(tmpDir, `${workflow.id}.json`), withoutPrUrl);

		const loaded = await store.load(workflow.id);
		expect(loaded).not.toBeNull();
		// prUrl should be undefined (missing from JSON), which is treated as null
		expect(loaded?.prUrl ?? null).toBeNull();
	});
});
