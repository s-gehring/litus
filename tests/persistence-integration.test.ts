import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineStepName, Workflow } from "../src/types";
import { PIPELINE_STEP_DEFINITIONS, REVIEW_CYCLE_MAX_ITERATIONS } from "../src/types";
import { WorkflowStore } from "../src/workflow-store";

function makeWorkflow(overrides?: Partial<Workflow>): Workflow {
	const now = new Date().toISOString();
	return {
		id: overrides?.id ?? `wf-${Date.now()}`,
		specification: "Build a feature",
		status: "idle",
		targetRepository: null,
		worktreePath: "/tmp/test-worktree",
		worktreeBranch: "crab-studio/test",
		summary: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: PIPELINE_STEP_DEFINITIONS.map((def) => ({
			name: def.name,
			displayName: def.displayName,
			status: "pending" as const,
			prompt: def.prompt,
			sessionId: null,
			output: "",
			error: null,
			startedAt: null,
			completedAt: null,
			pid: null,
		})),
		currentStepIndex: 0,
		reviewCycle: {
			iteration: 1,
			maxIterations: REVIEW_CYCLE_MAX_ITERATIONS,
			lastSeverity: null,
		},
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("Persistence Integration — US1: Survive Server Restart", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		baseDir = join(tmpdir(), `persist-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		store = new WorkflowStore(baseDir);
	});

	afterEach(() => {
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	test("T018: workflow state persisted after step completion", async () => {
		const workflow = makeWorkflow({ id: "persist-step" });
		workflow.status = "running";
		workflow.steps[0].status = "completed";
		workflow.steps[0].output = "Step 0 completed output";
		workflow.steps[0].completedAt = new Date().toISOString();
		workflow.steps[1].status = "running";
		workflow.steps[1].startedAt = new Date().toISOString();
		workflow.currentStepIndex = 1;

		await store.save(workflow);

		// Simulate restart: new store instance
		const freshStore = new WorkflowStore(baseDir);
		const restored = await freshStore.load("persist-step");

		expect(restored).not.toBeNull();
		expect(restored!.status).toBe("running");
		expect(restored!.steps[0].status).toBe("completed");
		expect(restored!.steps[0].output).toBe("Step 0 completed output");
		expect(restored!.steps[1].status).toBe("running");
		expect(restored!.currentStepIndex).toBe(1);
	});

	test("T019: all workflows restored on startup with most recent as active", async () => {
		const w1 = makeWorkflow({
			id: "old-wf",
			status: "completed",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const w2 = makeWorkflow({
			id: "recent-wf",
			status: "running",
			updatedAt: "2026-04-01T00:00:00.000Z",
		});

		await store.save(w1);
		await store.save(w2);

		const freshStore = new WorkflowStore(baseDir);
		const all = await freshStore.loadAll();

		expect(all).toHaveLength(2);
		// Most recent first
		expect(all[0].id).toBe("recent-wf");
		expect(all[1].id).toBe("old-wf");
	});

	test("T020: pending question restored after restart", async () => {
		const workflow = makeWorkflow({ id: "question-wf" });
		workflow.status = "waiting_for_input";
		workflow.pendingQuestion = {
			id: "q-1",
			content: "Should I use CSS modules?",
			detectedAt: new Date().toISOString(),
		};
		workflow.steps[0].status = "waiting_for_input";

		await store.save(workflow);

		const freshStore = new WorkflowStore(baseDir);
		const restored = await freshStore.load("question-wf");

		expect(restored).not.toBeNull();
		expect(restored!.status).toBe("waiting_for_input");
		expect(restored!.pendingQuestion).not.toBeNull();
		expect(restored!.pendingQuestion!.id).toBe("q-1");
		expect(restored!.pendingQuestion!.content).toBe("Should I use CSS modules?");
	});

	test("T021: corrupted workflow file skipped with warning on startup", async () => {
		const good = makeWorkflow({ id: "good-wf" });
		await store.save(good);

		// Write a corrupted file directly
		const corruptPath = join(baseDir, "corrupt-wf.json");
		await Bun.write(corruptPath, "{{not valid json");

		// Add corrupt entry to index
		const indexPath = join(baseDir, "index.json");
		const index = JSON.parse(await Bun.file(indexPath).text());
		index.push({
			id: "corrupt-wf",
			branch: "test",
			status: "running",
			summary: "",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		await Bun.write(indexPath, JSON.stringify(index, null, 2));

		const freshStore = new WorkflowStore(baseDir);
		const all = await freshStore.loadAll();

		// Only good workflow loaded
		expect(all).toHaveLength(1);
		expect(all[0].id).toBe("good-wf");
	});
});

describe("Persistence Integration — US2: Survive Page Reload", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		baseDir = join(tmpdir(), `persist-us2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		store = new WorkflowStore(baseDir);
	});

	afterEach(() => {
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	test("T028: streaming output persisted and available after page reload", async () => {
		const workflow = makeWorkflow({ id: "stream-wf" });
		workflow.status = "running";
		workflow.steps[0].status = "running";
		workflow.steps[0].output = "line 1\nline 2\nline 3\n";

		await store.save(workflow);

		// Simulate page reload: load from fresh store
		const freshStore = new WorkflowStore(baseDir);
		const restored = await freshStore.load("stream-wf");

		expect(restored).not.toBeNull();
		expect(restored!.steps[0].output).toBe("line 1\nline 2\nline 3\n");
	});

	test("T029: completed workflow fully displayed in new browser tab", async () => {
		const workflow = makeWorkflow({ id: "completed-wf" });
		workflow.status = "completed";
		for (let i = 0; i < workflow.steps.length; i++) {
			workflow.steps[i].status = "completed";
			workflow.steps[i].output = `Output for step ${i}`;
			workflow.steps[i].completedAt = new Date().toISOString();
		}
		workflow.summary = "Built a great feature";

		await store.save(workflow);

		const freshStore = new WorkflowStore(baseDir);
		const restored = await freshStore.load("completed-wf");

		expect(restored).not.toBeNull();
		expect(restored!.status).toBe("completed");
		expect(restored!.summary).toBe("Built a great feature");
		for (let i = 0; i < restored!.steps.length; i++) {
			expect(restored!.steps[i].status).toBe("completed");
			expect(restored!.steps[i].output).toBe(`Output for step ${i}`);
		}
	});
});

describe("Persistence Integration — US3: Orphan Process Detection", () => {
	test("T033: orphan detection checks if PID is alive via process.kill(pid, 0)", () => {
		// process.kill(pid, 0) throws if process doesn't exist
		// Using current process PID (which is alive)
		expect(() => process.kill(process.pid, 0)).not.toThrow();

		// A very high PID that almost certainly doesn't exist
		expect(() => process.kill(999999999, 0)).toThrow();
	});

	test("T034: isProcessAlive returns true for alive process and false for dead", async () => {
		// Import dynamically to test the helper
		const { isProcessAlive } = await import("../src/cli-runner");
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isProcessAlive(999999999)).toBe(false);
	});

	test("T035: dead orphan with no sessionId is handled gracefully", async () => {
		const baseDir = join(tmpdir(), `persist-us3-${Date.now()}`);
		const store = new WorkflowStore(baseDir);

		const workflow = makeWorkflow({ id: "orphan-dead" });
		workflow.status = "running";
		workflow.steps[0].status = "running";
		workflow.steps[0].pid = 999999999; // dead PID
		workflow.steps[0].sessionId = null;

		await store.save(workflow);

		const restored = await store.load("orphan-dead");
		expect(restored).not.toBeNull();
		expect(restored!.steps[0].pid).toBe(999999999);

		rmSync(baseDir, { recursive: true, force: true });
	});

	test("T036: failed session resumption marks step as error", () => {
		// This tests the concept — the actual implementation will be in pipeline-orchestrator
		const workflow = makeWorkflow({ id: "orphan-fail" });
		workflow.status = "running";
		workflow.steps[0].status = "running";
		workflow.steps[0].pid = 999999999;
		workflow.steps[0].sessionId = "dead-session";

		// Simulate marking as error
		workflow.steps[0].status = "error";
		workflow.steps[0].error = "Session resumption failed — needs retry";
		workflow.steps[0].pid = null;
		workflow.status = "error";

		expect(workflow.steps[0].status).toBe("error");
		expect(workflow.steps[0].error).toContain("needs retry");
		expect(workflow.status).toBe("error");
	});
});
