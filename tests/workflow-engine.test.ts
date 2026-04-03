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
		// Mock git worktree creation
		BunGlobal.Bun.spawn = (..._args: unknown[]) => {
			return {
				exited: Promise.resolve(0),
				stdout: null,
				stderr: null,
				kill: () => {},
				pid: 1234,
			};
		};
	});

	// Restore after all tests
	afterAll(() => {
		BunGlobal.Bun.spawn = originalSpawn;
	});

	test("getWorkflow returns null initially", () => {
		expect(engine.getWorkflow()).toBeNull();
	});

	test("createWorkflow creates a workflow in idle state", async () => {
		const w = await engine.createWorkflow("Build a login page");
		expect(w.id).toBeTruthy();
		expect(w.specification).toBe("Build a login page");
		expect(w.status).toBe("idle");
		expect(w.worktreePath).toBeTruthy();
		expect(w.worktreeBranch).toMatch(/^crab-studio\//);
		expect(w.summary).toBe("");
		expect(w.pendingQuestion).toBeNull();
		expect(w.lastOutput).toBe("");
		expect(w.createdAt).toBeTruthy();
		expect(w.updatedAt).toBeTruthy();
	});

	test("getWorkflow returns created workflow", async () => {
		await engine.createWorkflow("test");
		expect(engine.getWorkflow()).not.toBeNull();
		expect(engine.getWorkflow()?.specification).toBe("test");
	});

	describe("state transitions", () => {
		test("idle → running", async () => {
			const w = await engine.createWorkflow("test");
			engine.transition(w.id, "running");
			expect(engine.getWorkflow()?.status).toBe("running");
		});

		test("running → waiting_for_input", async () => {
			const w = await engine.createWorkflow("test");
			engine.transition(w.id, "running");
			engine.transition(w.id, "waiting_for_input");
			expect(engine.getWorkflow()?.status).toBe("waiting_for_input");
		});

		test("running → completed", async () => {
			const w = await engine.createWorkflow("test");
			engine.transition(w.id, "running");
			engine.transition(w.id, "completed");
			expect(engine.getWorkflow()?.status).toBe("completed");
		});

		test("running → error", async () => {
			const w = await engine.createWorkflow("test");
			engine.transition(w.id, "running");
			engine.transition(w.id, "error");
			expect(engine.getWorkflow()?.status).toBe("error");
		});

		test("running → cancelled", async () => {
			const w = await engine.createWorkflow("test");
			engine.transition(w.id, "running");
			engine.transition(w.id, "cancelled");
			expect(engine.getWorkflow()?.status).toBe("cancelled");
		});

		test("waiting_for_input → running", async () => {
			const w = await engine.createWorkflow("test");
			engine.transition(w.id, "running");
			engine.transition(w.id, "waiting_for_input");
			engine.transition(w.id, "running");
			expect(engine.getWorkflow()?.status).toBe("running");
		});

		test("waiting_for_input → cancelled", async () => {
			const w = await engine.createWorkflow("test");
			engine.transition(w.id, "running");
			engine.transition(w.id, "waiting_for_input");
			engine.transition(w.id, "cancelled");
			expect(engine.getWorkflow()?.status).toBe("cancelled");
		});
	});

	describe("invalid transitions", () => {
		test("idle → completed throws", async () => {
			const w = await engine.createWorkflow("test");
			expect(() => engine.transition(w.id, "completed")).toThrow("Invalid transition");
		});

		test("completed → running throws", async () => {
			const w = await engine.createWorkflow("test");
			engine.transition(w.id, "running");
			engine.transition(w.id, "completed");
			expect(() => engine.transition(w.id, "running")).toThrow("Invalid transition");
		});

		test("cancelled → running throws", async () => {
			const w = await engine.createWorkflow("test");
			engine.transition(w.id, "running");
			engine.transition(w.id, "cancelled");
			expect(() => engine.transition(w.id, "running")).toThrow("Invalid transition");
		});

		test("error → running is allowed (retry)", async () => {
			const w = await engine.createWorkflow("test");
			engine.transition(w.id, "running");
			engine.transition(w.id, "error");
			engine.transition(w.id, "running");
			expect(engine.getWorkflow()?.status).toBe("running");
		});

		test("idle → waiting_for_input throws", async () => {
			const w = await engine.createWorkflow("test");
			expect(() => engine.transition(w.id, "waiting_for_input")).toThrow("Invalid transition");
		});
	});

	test("transition with wrong workflow ID throws", async () => {
		await engine.createWorkflow("test");
		expect(() => engine.transition("wrong-id", "running")).toThrow("not found");
	});

	test("updateLastOutput updates the workflow", async () => {
		const w = await engine.createWorkflow("test");
		engine.updateLastOutput(w.id, "some output");
		expect(engine.getWorkflow()?.lastOutput).toBe("some output");
	});

	test("updateSummary updates the workflow", async () => {
		const w = await engine.createWorkflow("test");
		engine.updateSummary(w.id, "Building components");
		expect(engine.getWorkflow()?.summary).toBe("Building components");
	});

	test("setQuestion and clearQuestion", async () => {
		const w = await engine.createWorkflow("test");
		const question: Question = {
			id: "q1",
			content: "Should I use CSS modules?",
			confidence: "certain",
			detectedAt: new Date().toISOString(),
		};
		engine.setQuestion(w.id, question);
		expect(engine.getWorkflow()?.pendingQuestion).toEqual(question);

		engine.clearQuestion(w.id);
		expect(engine.getWorkflow()?.pendingQuestion).toBeNull();
	});

	test("updatedAt changes on mutations", async () => {
		const w = await engine.createWorkflow("test");
		const initial = w.updatedAt;
		// Small delay to ensure timestamp differs
		await new Promise((r) => setTimeout(r, 5));
		engine.updateLastOutput(w.id, "new output");
		expect(engine.getWorkflow()?.updatedAt).not.toBe(initial);
	});

	test("createWorkflow overwrites previous workflow", async () => {
		const _w1 = await engine.createWorkflow("first");
		const w2 = await engine.createWorkflow("second");
		expect(engine.getWorkflow()?.id).toBe(w2.id);
		expect(engine.getWorkflow()?.specification).toBe("second");
	});

	describe("pipeline fields", () => {
		test("createWorkflow initializes steps array with 8 entries", async () => {
			const w = await engine.createWorkflow("Build a login page");
			expect(w.steps).toHaveLength(8);
			expect(w.steps[0].name).toBe("specify");
			expect(w.steps[7].name).toBe("commit-push-pr");
		});

		test("all steps start as pending", async () => {
			const w = await engine.createWorkflow("test");
			for (const step of w.steps) {
				expect(step.status).toBe("pending");
			}
		});

		test("specify step prompt includes specification text", async () => {
			const w = await engine.createWorkflow("Build a login page");
			expect(w.steps[0].prompt).toBe("/speckit.specify Build a login page");
		});

		test("non-specify steps have bare prompts", async () => {
			const w = await engine.createWorkflow("test");
			expect(w.steps[1].prompt).toBe("/speckit.clarify");
			expect(w.steps[2].prompt).toBe("/speckit.plan");
		});

		test("currentStepIndex starts at 0", async () => {
			const w = await engine.createWorkflow("test");
			expect(w.currentStepIndex).toBe(0);
		});

		test("reviewCycle initializes correctly", async () => {
			const w = await engine.createWorkflow("test");
			expect(w.reviewCycle.iteration).toBe(1);
			expect(w.reviewCycle.maxIterations).toBe(16);
			expect(w.reviewCycle.lastSeverity).toBeNull();
		});

		test("error → running transition works (retry support)", async () => {
			const w = await engine.createWorkflow("test");
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

		test("createWorkflow without targetRepository defaults to null", async () => {
			const w = await engine.createWorkflow("test");
			expect(w.targetRepository).toBeNull();
		});

		test("createWorkflow with null targetRepository stores null", async () => {
			const w = await engine.createWorkflow("test", null);
			expect(w.targetRepository).toBeNull();
		});

		test("worktree cwd uses targetRepository when provided", async () => {
			let capturedCwd: string | undefined;
			BunGlobal.Bun.spawn = (_cmd: unknown, opts: { cwd?: string }) => {
				capturedCwd = opts?.cwd;
				return {
					exited: Promise.resolve(0),
					stdout: null,
					stderr: null,
					kill: () => {},
					pid: 1234,
				};
			};

			await engine.createWorkflow("test", "/custom/repo");
			expect(capturedCwd).toBe("/custom/repo");
		});

		test("worktree cwd falls back to process.cwd() when no targetRepository", async () => {
			let capturedCwd: string | undefined;
			BunGlobal.Bun.spawn = (_cmd: unknown, opts: { cwd?: string }) => {
				capturedCwd = opts?.cwd;
				return {
					exited: Promise.resolve(0),
					stdout: null,
					stderr: null,
					kill: () => {},
					pid: 1234,
				};
			};

			await engine.createWorkflow("test");
			expect(capturedCwd).toBe(process.cwd());
		});
	});

	test("worktree creation failure throws descriptive error", async () => {
		BunGlobal.Bun.spawn = (..._args: unknown[]) => {
			return {
				exited: Promise.resolve(128),
				stdout: null,
				stderr: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("fatal: branch already exists"));
						controller.close();
					},
				}),
				kill: () => {},
				pid: 1234,
			};
		};

		await expect(engine.createWorkflow("test")).rejects.toThrow("Failed to create git worktree");
	});
});
