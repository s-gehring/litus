import { describe, expect, test } from "bun:test";
import type {
	PipelineStep,
	PipelineStepName,
	PipelineStepStatus,
	ReviewCycle,
	ReviewSeverity,
	WorkflowStatus,
} from "../src/types";
import {
	PIPELINE_STEP_DEFINITIONS,
	REVIEW_CYCLE_MAX_ITERATIONS,
	VALID_TRANSITIONS,
} from "../src/types";

describe("VALID_TRANSITIONS", () => {
	test("idle can only transition to running", () => {
		expect(VALID_TRANSITIONS.idle).toEqual(["running"]);
	});

	test("running can transition to waiting_for_input, completed, error, cancelled", () => {
		expect(VALID_TRANSITIONS.running).toEqual([
			"waiting_for_input",
			"completed",
			"error",
			"cancelled",
		]);
	});

	test("waiting_for_input can transition to running or cancelled", () => {
		expect(VALID_TRANSITIONS.waiting_for_input).toEqual(["running", "cancelled"]);
	});

	test("completed and cancelled are terminal states", () => {
		expect(VALID_TRANSITIONS.completed).toEqual([]);
		expect(VALID_TRANSITIONS.cancelled).toEqual([]);
	});

	test("error can transition to running (retry)", () => {
		expect(VALID_TRANSITIONS.error).toEqual(["running"]);
	});

	test("all workflow statuses are covered", () => {
		const allStatuses: WorkflowStatus[] = [
			"idle",
			"running",
			"waiting_for_input",
			"completed",
			"cancelled",
			"error",
		];
		for (const status of allStatuses) {
			expect(VALID_TRANSITIONS).toHaveProperty(status);
		}
	});
});

describe("PIPELINE_STEP_DEFINITIONS", () => {
	test("has exactly 8 steps in correct order", () => {
		const expectedNames: PipelineStepName[] = [
			"specify",
			"clarify",
			"plan",
			"tasks",
			"implement",
			"review",
			"implement-review",
			"commit-push-pr",
		];
		expect(PIPELINE_STEP_DEFINITIONS.map((s) => s.name)).toEqual(expectedNames);
	});

	test("every step has a non-empty displayName and prompt", () => {
		for (const step of PIPELINE_STEP_DEFINITIONS) {
			expect(step.displayName.length).toBeGreaterThan(0);
			expect(step.prompt.length).toBeGreaterThan(0);
		}
	});
});

describe("REVIEW_CYCLE_MAX_ITERATIONS", () => {
	test("is 16", () => {
		expect(REVIEW_CYCLE_MAX_ITERATIONS).toBe(16);
	});
});

describe("PipelineStep shape", () => {
	test("a valid PipelineStep can be constructed", () => {
		const step: PipelineStep = {
			name: "specify",
			displayName: "Specifying",
			status: "pending",
			prompt: "/speckit.specify test",
			sessionId: null,
			output: "",
			error: null,
			startedAt: null,
			completedAt: null,
			pid: null,
		};
		expect(step.name).toBe("specify");
		expect(step.status).toBe("pending");
	});

	test("all PipelineStepStatus values are valid", () => {
		const statuses: PipelineStepStatus[] = [
			"pending",
			"running",
			"waiting_for_input",
			"completed",
			"error",
		];
		expect(statuses).toHaveLength(5);
	});
});

describe("ReviewCycle shape", () => {
	test("a valid ReviewCycle can be constructed", () => {
		const cycle: ReviewCycle = {
			iteration: 1,
			maxIterations: 16,
			lastSeverity: null,
		};
		expect(cycle.iteration).toBe(1);
		expect(cycle.maxIterations).toBe(16);
		expect(cycle.lastSeverity).toBeNull();
	});

	test("all ReviewSeverity values are valid", () => {
		const severities: ReviewSeverity[] = ["critical", "major", "minor", "trivial", "nit"];
		expect(severities).toHaveLength(5);
	});

	test("review severity type covers all five levels", () => {
		const allSeverities: ReviewSeverity[] = ["critical", "major", "minor", "trivial", "nit"];
		expect(allSeverities).toHaveLength(5);
		expect(new Set(allSeverities).size).toBe(5);
	});
});
