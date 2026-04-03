import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowStore } from "../src/workflow-store";
import { assertDefined, makeWorkflow } from "./helpers";

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

		const freshStore = new WorkflowStore(baseDir);
		const restored = await freshStore.load("persist-step");
		assertDefined(restored);

		expect(restored.status).toBe("running");
		expect(restored.steps[0].status).toBe("completed");
		expect(restored.steps[0].output).toBe("Step 0 completed output");
		expect(restored.steps[1].status).toBe("running");
		expect(restored.currentStepIndex).toBe(1);
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
		assertDefined(restored);

		expect(restored.status).toBe("waiting_for_input");
		assertDefined(restored.pendingQuestion);
		expect(restored.pendingQuestion.id).toBe("q-1");
		expect(restored.pendingQuestion.content).toBe("Should I use CSS modules?");
	});

	test("T021: corrupted workflow file skipped with warning on startup", async () => {
		const good = makeWorkflow({ id: "good-wf" });
		await store.save(good);

		const corruptPath = join(baseDir, "corrupt-wf.json");
		await Bun.write(corruptPath, "{{not valid json");

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

		const freshStore = new WorkflowStore(baseDir);
		const restored = await freshStore.load("stream-wf");
		assertDefined(restored);

		expect(restored.steps[0].output).toBe("line 1\nline 2\nline 3\n");
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
		assertDefined(restored);

		expect(restored.status).toBe("completed");
		expect(restored.summary).toBe("Built a great feature");
		for (let i = 0; i < restored.steps.length; i++) {
			expect(restored.steps[i].status).toBe("completed");
			expect(restored.steps[i].output).toBe(`Output for step ${i}`);
		}
	});
});

describe("Persistence Integration — US3: Orphan Process Detection", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		baseDir = join(tmpdir(), `persist-us3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		store = new WorkflowStore(baseDir);
	});

	afterEach(() => {
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	test("T034: isProcessAlive returns true for alive process and false for dead", async () => {
		const { isProcessAlive } = await import("../src/cli-runner");
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isProcessAlive(999999999)).toBe(false);
	});

	test("T035: dead orphan with no sessionId is marked as error by recoverOrphans", async () => {
		const { PipelineOrchestrator } = await import("../src/pipeline-orchestrator");

		const workflow = makeWorkflow({ id: "orphan-dead", worktreePath: baseDir });
		workflow.status = "running";
		workflow.steps[0].status = "running";
		workflow.steps[0].pid = 999999999;
		workflow.steps[0].sessionId = null;

		await store.save(workflow);

		const callbacks = {
			onStepChange: () => {},
			onOutput: () => {},
			onComplete: () => {},
			onError: () => {},
			onStateChange: () => {},
		};
		const orchestrator = new PipelineOrchestrator(callbacks, { workflowStore: store });
		const restored = await orchestrator.restoreWorkflows();

		expect(restored).toHaveLength(1);
		expect(restored[0].steps[0].status).toBe("error");
		expect(restored[0].steps[0].error).toContain("needs retry");
		expect(restored[0].steps[0].pid).toBeNull();
		expect(restored[0].status).toBe("error");
	});

	test("T033: alive orphan is killed during recovery", async () => {
		const { PipelineOrchestrator } = await import("../src/pipeline-orchestrator");
		const { isProcessAlive } = await import("../src/cli-runner");

		// Spawn a real long-running process to act as an orphan
		const child = Bun.spawn(["node", "-e", "setTimeout(() => {}, 60000)"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const pid = child.pid;
		expect(isProcessAlive(pid)).toBe(true);

		const workflow = makeWorkflow({ id: "orphan-alive", worktreePath: baseDir });
		workflow.status = "running";
		workflow.steps[0].status = "running";
		workflow.steps[0].pid = pid;
		workflow.steps[0].sessionId = null;

		await store.save(workflow);

		const callbacks = {
			onStepChange: () => {},
			onOutput: () => {},
			onComplete: () => {},
			onError: () => {},
			onStateChange: () => {},
		};
		const orchestrator = new PipelineOrchestrator(callbacks, { workflowStore: store });
		const restored = await orchestrator.restoreWorkflows();

		expect(restored).toHaveLength(1);
		expect(restored[0].steps[0].pid).toBeNull();
		expect(restored[0].steps[0].status).toBe("error");
		// Process should have been killed
		expect(isProcessAlive(pid)).toBe(false);
	});

	test("T036: dead orphan with sessionId is marked as error by recoverOrphans", async () => {
		const { PipelineOrchestrator } = await import("../src/pipeline-orchestrator");

		const workflow = makeWorkflow({ id: "orphan-session", worktreePath: baseDir });
		workflow.status = "running";
		workflow.steps[0].status = "running";
		workflow.steps[0].pid = 999999999;
		workflow.steps[0].sessionId = "dead-session";

		await store.save(workflow);

		// Use a CLI runner that throws on start to simulate resumption failure
		const fakeCliRunner = {
			start: () => {
				throw new Error("CLI not available");
			},
			kill: () => {},
			sendAnswer: () => {},
			killAll: () => {},
		};
		const callbacks = {
			onStepChange: () => {},
			onOutput: () => {},
			onComplete: () => {},
			onError: () => {},
			onStateChange: () => {},
		};
		const orchestrator = new PipelineOrchestrator(callbacks, {
			workflowStore: store,
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fakes
			cliRunner: fakeCliRunner as any,
		});
		const restored = await orchestrator.restoreWorkflows();

		expect(restored).toHaveLength(1);
		expect(restored[0].steps[0].status).toBe("error");
		expect(restored[0].steps[0].error).toContain("needs retry");
		expect(restored[0].steps[0].pid).toBeNull();
		expect(restored[0].status).toBe("error");
	});
});
