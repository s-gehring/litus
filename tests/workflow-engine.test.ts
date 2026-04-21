import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Question } from "../src/types";
import { WorkflowEngine } from "../src/workflow-engine";

// Mock Bun.spawn to avoid actual git operations
const originalSpawn = Bun.spawn;
const BunGlobal = globalThis as unknown as { Bun: { spawn: unknown } };

describe("WorkflowEngine", () => {
	let engine: WorkflowEngine;

	beforeEach(() => {
		engine = new WorkflowEngine();
	});

	// Restore after all tests
	afterAll(() => {
		BunGlobal.Bun.spawn = originalSpawn;
	});

	test("getWorkflow returns null initially", () => {
		expect(engine.getWorkflow()).toBeNull();
	});

	test("createWorkflow creates a workflow in idle state with null worktreePath", async () => {
		const w = await engine.createWorkflow("Build a login page", "/tmp/test-repo");
		expect(w.id).toBeTruthy();
		expect(w.specification).toBe("Build a login page");
		expect(w.status).toBe("idle");
		expect(w.worktreePath).toBeNull();
		expect(w.worktreeBranch).toMatch(/^tmp-/);
		expect(w.summary).toBe("");
		expect(w.pendingQuestion).toBeNull();
		expect(w.lastOutput).toBe("");
		expect(w.createdAt).toBeTruthy();
		expect(w.updatedAt).toBeTruthy();
	});

	test("createWorktree and copyGitignoredFiles are callable as public methods", () => {
		expect(typeof engine.createWorktree).toBe("function");
		expect(typeof engine.copyGitignoredFiles).toBe("function");
	});

	test("getWorkflow returns created workflow", async () => {
		await engine.createWorkflow("test", "/tmp/test-repo");
		expect(engine.getWorkflow()).not.toBeNull();
		expect(engine.getWorkflow()?.specification).toBe("test");
	});

	describe("state transitions", () => {
		test("idle → running", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			expect(engine.getWorkflow()?.status).toBe("running");
		});

		test("running → waiting_for_input", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "waiting_for_input");
			expect(engine.getWorkflow()?.status).toBe("waiting_for_input");
		});

		test("running → completed", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "completed");
			expect(engine.getWorkflow()?.status).toBe("completed");
		});

		test("running → error", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "error");
			expect(engine.getWorkflow()?.status).toBe("error");
		});

		test("running → paused", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "paused");
			expect(engine.getWorkflow()?.status).toBe("paused");
		});

		test("paused → running (resume)", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "paused");
			engine.transition(w.id, "running");
			expect(engine.getWorkflow()?.status).toBe("running");
		});

		test("paused → error (late error callback)", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "paused");
			engine.transition(w.id, "error");
			expect(engine.getWorkflow()?.status).toBe("error");
		});

		test("paused → aborted (abort)", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "paused");
			engine.transition(w.id, "aborted");
			expect(engine.getWorkflow()?.status).toBe("aborted");
		});

		test("waiting_for_input → running", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "waiting_for_input");
			engine.transition(w.id, "running");
			expect(engine.getWorkflow()?.status).toBe("running");
		});

		test("waiting_for_input → aborted", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "waiting_for_input");
			engine.transition(w.id, "aborted");
			expect(engine.getWorkflow()?.status).toBe("aborted");
		});
	});

	describe("transition clears activeInvocation on terminal states (CR-2)", () => {
		function seedActive(): void {
			const current = engine.getWorkflow();
			if (!current) throw new Error("no workflow");
			current.activeInvocation = {
				model: "claude-opus-4-7",
				effort: "high",
				stepName: "specify",
				startedAt: new Date().toISOString(),
				role: "main",
			};
		}

		test("running → completed clears activeInvocation", async () => {
			const w = await engine.createWorkflow("t", "/tmp/r");
			engine.transition(w.id, "running");
			seedActive();
			engine.transition(w.id, "completed");
			expect(engine.getWorkflow()?.activeInvocation).toBeNull();
		});

		test("running → error clears activeInvocation", async () => {
			const w = await engine.createWorkflow("t", "/tmp/r");
			engine.transition(w.id, "running");
			seedActive();
			engine.transition(w.id, "error");
			expect(engine.getWorkflow()?.activeInvocation).toBeNull();
		});

		test("running → waiting_for_input → aborted clears activeInvocation", async () => {
			const w = await engine.createWorkflow("t", "/tmp/r");
			engine.transition(w.id, "running");
			seedActive();
			engine.transition(w.id, "waiting_for_input");
			// waiting_for_input is not a terminal state — value must persist.
			expect(engine.getWorkflow()?.activeInvocation).not.toBeNull();
			engine.transition(w.id, "aborted");
			expect(engine.getWorkflow()?.activeInvocation).toBeNull();
		});

		test("running → paused preserves activeInvocation", async () => {
			const w = await engine.createWorkflow("t", "/tmp/r");
			engine.transition(w.id, "running");
			seedActive();
			engine.transition(w.id, "paused");
			expect(engine.getWorkflow()?.activeInvocation).not.toBeNull();
			expect(engine.getWorkflow()?.activeInvocation?.model).toBe("claude-opus-4-7");
		});

		test("paused → running preserves activeInvocation", async () => {
			const w = await engine.createWorkflow("t", "/tmp/r");
			engine.transition(w.id, "running");
			seedActive();
			engine.transition(w.id, "paused");
			engine.transition(w.id, "running");
			expect(engine.getWorkflow()?.activeInvocation).not.toBeNull();
		});
	});

	describe("invalid transitions", () => {
		test("idle → completed throws", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			expect(() => engine.transition(w.id, "completed")).toThrow("Invalid transition");
		});

		test("completed → running throws", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "completed");
			expect(() => engine.transition(w.id, "running")).toThrow("Invalid transition");
		});

		test("aborted → running throws", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "paused");
			engine.transition(w.id, "aborted");
			expect(() => engine.transition(w.id, "running")).toThrow("Invalid transition");
		});

		test("running → aborted throws (must pause first)", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			expect(() => engine.transition(w.id, "aborted")).toThrow("Invalid transition");
		});

		test("error → running is allowed (retry)", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "error");
			engine.transition(w.id, "running");
			expect(engine.getWorkflow()?.status).toBe("running");
		});

		test("idle → waiting_for_input throws", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			expect(() => engine.transition(w.id, "waiting_for_input")).toThrow("Invalid transition");
		});
	});

	test("transition with wrong workflow ID throws", async () => {
		await engine.createWorkflow("test", "/tmp/test-repo");
		expect(() => engine.transition("wrong-id", "running")).toThrow("not found");
	});

	test("updateLastOutput updates the workflow", async () => {
		const w = await engine.createWorkflow("test", "/tmp/test-repo");
		engine.updateLastOutput(w.id, "some output");
		expect(engine.getWorkflow()?.lastOutput).toBe("some output");
	});

	test("updateSummary updates the workflow", async () => {
		const w = await engine.createWorkflow("test", "/tmp/test-repo");
		engine.updateSummary(w.id, "Building components");
		expect(engine.getWorkflow()?.summary).toBe("Building components");
	});

	test("setQuestion and clearQuestion", async () => {
		const w = await engine.createWorkflow("test", "/tmp/test-repo");
		const question: Question = {
			id: "q1",
			content: "Should I use CSS modules?",
			detectedAt: new Date().toISOString(),
		};
		engine.setQuestion(w.id, question);
		expect(engine.getWorkflow()?.pendingQuestion).toEqual(question);

		engine.clearQuestion(w.id);
		expect(engine.getWorkflow()?.pendingQuestion).toBeNull();
	});

	test("updatedAt changes on mutations", async () => {
		const w = await engine.createWorkflow("test", "/tmp/test-repo");
		const initial = w.updatedAt;
		// Small delay to ensure timestamp differs
		await new Promise((r) => setTimeout(r, 5));
		engine.updateLastOutput(w.id, "new output");
		expect(engine.getWorkflow()?.updatedAt).not.toBe(initial);
	});

	test("createWorkflow overwrites previous workflow", async () => {
		const _w1 = await engine.createWorkflow("first", "/tmp/test-repo");
		const w2 = await engine.createWorkflow("second", "/tmp/test-repo");
		expect(engine.getWorkflow()?.id).toBe(w2.id);
		expect(engine.getWorkflow()?.specification).toBe("second");
	});

	describe("pipeline fields", () => {
		test("createWorkflow initializes steps array with 15 entries", async () => {
			const w = await engine.createWorkflow("Build a login page", "/tmp/test-repo");
			expect(w.steps).toHaveLength(15);
			expect(w.steps[0].name).toBe("setup");
			expect(w.steps[1].name).toBe("specify");
			expect(w.steps[8].name).toBe("artifacts");
			expect(w.steps[9].name).toBe("commit-push-pr");
			expect(w.steps[12].name).toBe("feedback-implementer");
			expect(w.steps[13].name).toBe("merge-pr");
			expect(w.steps[14].name).toBe("sync-repo");
		});

		test("createWorkflow initializes feedbackEntries to empty array", async () => {
			const w = await engine.createWorkflow("Build a login page", "/tmp/test-repo");
			expect(w.feedbackEntries).toEqual([]);
		});

		test("all steps start as pending", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			for (const step of w.steps) {
				expect(step.status).toBe("pending");
			}
		});

		test("specify step prompt includes specification text", async () => {
			const w = await engine.createWorkflow("Build a login page", "/tmp/test-repo");
			expect(w.steps[1].prompt).toBe("/speckit-specify Build a login page");
		});

		test("non-specify steps have bare prompts", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			expect(w.steps[2].prompt).toBe("/speckit-clarify");
			expect(w.steps[3].prompt).toBe("/speckit-plan");
		});

		test("currentStepIndex starts at 0", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			expect(w.currentStepIndex).toBe(0);
		});

		test("reviewCycle initializes correctly", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			expect(w.reviewCycle.iteration).toBe(1);
			expect(w.reviewCycle.maxIterations).toBe(16);
			expect(w.reviewCycle.lastSeverity).toBeNull();
		});

		test("error → running transition works (retry support)", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			engine.transition(w.id, "running");
			engine.transition(w.id, "error");
			engine.transition(w.id, "running");
			expect(engine.getWorkflow()?.status).toBe("running");
		});
	});

	describe("targetRepository parameter", () => {
		test("createWorkflow with targetRepository stores it on workflow", async () => {
			const w = await engine.createWorkflow("test", "/some/repo/path");
			expect(w.targetRepository).toBe("/some/repo/path");
		});

		test("createWorkflow stores targetRepository on workflow", async () => {
			const w = await engine.createWorkflow("test", "/tmp/test-repo");
			expect(w.targetRepository).toBe("/tmp/test-repo");
		});

		test("createWorkflow does not invoke git worktree", async () => {
			let spawnCalled = false;
			BunGlobal.Bun.spawn = (..._args: unknown[]) => {
				spawnCalled = true;
				return {
					exited: Promise.resolve(0),
					stdout: null,
					stderr: null,
					kill: () => {},
					pid: 1234,
				};
			};

			await engine.createWorkflow("test", "/custom/repo");
			expect(spawnCalled).toBe(false);
		});
	});

	test("createWorkflow stores targetRepository on workflow", async () => {
		const w = await engine.createWorkflow("test", "/custom/repo");
		expect(w.targetRepository).toBe("/custom/repo");
	});

	describe("epic workflow creation", () => {
		test("createEpicWorkflows returns all workflows with worktreePath null", async () => {
			const { createEpicWorkflows } = await import("../src/workflow-engine");
			const result = await createEpicWorkflows(
				{
					title: "Test Epic",
					infeasibleNotes: null,
					summary: "Test summary",
					specs: [
						{ id: "s1", title: "Spec A", description: "Do A", dependencies: [] },
						{ id: "s2", title: "Spec B", description: "Do B", dependencies: ["s1"] },
					],
				},
				"/tmp/test-repo",
			);
			for (const wf of result.workflows) {
				expect(wf.worktreePath).toBeNull();
			}
		});

		test("single-spec epic fallback returns worktreePath null", async () => {
			const { createEpicWorkflows } = await import("../src/workflow-engine");
			const result = await createEpicWorkflows(
				{
					title: "Single Epic",
					infeasibleNotes: null,
					summary: "Single summary",
					specs: [{ id: "s1", title: "Only Spec", description: "Do it", dependencies: [] }],
				},
				"/tmp/test-repo",
			);
			expect(result.workflows).toHaveLength(1);
			expect(result.workflows[0].worktreePath).toBeNull();
		});
	});
});
