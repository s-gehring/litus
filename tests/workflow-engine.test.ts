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
		expect(w.sessionId).toBeNull();
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

	test("setSessionId updates the workflow", async () => {
		const w = await engine.createWorkflow("test");
		engine.setSessionId(w.id, "session-123");
		expect(engine.getWorkflow()?.sessionId).toBe("session-123");
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
