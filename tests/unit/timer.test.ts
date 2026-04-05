import { describe, expect, test } from "bun:test";
import { makeWorkflow } from "../helpers";

describe("Timer accumulation", () => {
	// We test timer logic by directly manipulating workflow fields
	// since WorkflowEngine.transition() now handles timer updates

	test("idle → running sets activeWorkStartedAt", () => {
		const { WorkflowEngine } = require("../../src/workflow-engine");
		const engine = new WorkflowEngine();
		const wf = makeWorkflow({ status: "idle" });
		engine.setWorkflow(wf);

		engine.transition(wf.id, "running");

		expect(wf.activeWorkStartedAt).not.toBeNull();
		expect(wf.activeWorkMs).toBe(0);
	});

	test("running → waiting_for_input accumulates time and clears startedAt", () => {
		const { WorkflowEngine } = require("../../src/workflow-engine");
		const engine = new WorkflowEngine();
		const startTime = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
		const wf = makeWorkflow({
			status: "running",
			activeWorkMs: 1000,
			activeWorkStartedAt: startTime,
		});
		engine.setWorkflow(wf);

		engine.transition(wf.id, "waiting_for_input");

		expect(wf.activeWorkStartedAt).toBeNull();
		// Should have accumulated ~5000ms on top of existing 1000ms
		expect(wf.activeWorkMs).toBeGreaterThanOrEqual(5000);
		expect(wf.activeWorkMs).toBeLessThan(7000);
	});

	test("running → completed accumulates time", () => {
		const { WorkflowEngine } = require("../../src/workflow-engine");
		const engine = new WorkflowEngine();
		const startTime = new Date(Date.now() - 3000).toISOString();
		const wf = makeWorkflow({
			status: "running",
			activeWorkMs: 0,
			activeWorkStartedAt: startTime,
		});
		engine.setWorkflow(wf);

		engine.transition(wf.id, "completed");

		expect(wf.activeWorkStartedAt).toBeNull();
		expect(wf.activeWorkMs).toBeGreaterThanOrEqual(2500);
	});

	test("running → error accumulates time", () => {
		const { WorkflowEngine } = require("../../src/workflow-engine");
		const engine = new WorkflowEngine();
		const startTime = new Date(Date.now() - 2000).toISOString();
		const wf = makeWorkflow({
			status: "running",
			activeWorkMs: 500,
			activeWorkStartedAt: startTime,
		});
		engine.setWorkflow(wf);

		engine.transition(wf.id, "error");

		expect(wf.activeWorkStartedAt).toBeNull();
		expect(wf.activeWorkMs).toBeGreaterThanOrEqual(2000);
	});

	test("running → paused accumulates time", () => {
		const { WorkflowEngine } = require("../../src/workflow-engine");
		const engine = new WorkflowEngine();
		const startTime = new Date(Date.now() - 1000).toISOString();
		const wf = makeWorkflow({
			status: "running",
			activeWorkMs: 0,
			activeWorkStartedAt: startTime,
		});
		engine.setWorkflow(wf);

		engine.transition(wf.id, "paused");

		expect(wf.activeWorkStartedAt).toBeNull();
		expect(wf.activeWorkMs).toBeGreaterThanOrEqual(900);
	});

	test("waiting_for_input → running sets activeWorkStartedAt without resetting ms", () => {
		const { WorkflowEngine } = require("../../src/workflow-engine");
		const engine = new WorkflowEngine();
		const wf = makeWorkflow({
			status: "waiting_for_input",
			activeWorkMs: 5000,
			activeWorkStartedAt: null,
		});
		engine.setWorkflow(wf);

		engine.transition(wf.id, "running");

		expect(wf.activeWorkStartedAt).not.toBeNull();
		expect(wf.activeWorkMs).toBe(5000); // Preserved
	});

	test("error → running (retry) sets activeWorkStartedAt", () => {
		const { WorkflowEngine } = require("../../src/workflow-engine");
		const engine = new WorkflowEngine();
		const wf = makeWorkflow({
			status: "error",
			activeWorkMs: 10000,
			activeWorkStartedAt: null,
		});
		engine.setWorkflow(wf);

		engine.transition(wf.id, "running");

		expect(wf.activeWorkStartedAt).not.toBeNull();
		expect(wf.activeWorkMs).toBe(10000); // Preserved
	});

	test("timer does not change when activeWorkStartedAt is null on leave-running", () => {
		const { WorkflowEngine } = require("../../src/workflow-engine");
		const engine = new WorkflowEngine();
		// Edge case: running but startedAt already null (shouldn't happen, but defensive)
		const wf = makeWorkflow({
			status: "running",
			activeWorkMs: 3000,
			activeWorkStartedAt: null,
		});
		engine.setWorkflow(wf);

		engine.transition(wf.id, "completed");

		expect(wf.activeWorkMs).toBe(3000); // Unchanged
		expect(wf.activeWorkStartedAt).toBeNull();
	});
});
