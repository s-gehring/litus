import { describe, expect, test } from "bun:test";
import type {
	MergeCycle,
	MergeResult,
	PipelineStep,
	PipelineStepName,
	PipelineStepStatus,
	ReviewCycle,
	ReviewSeverity,
	SyncResult,
	WorkflowStatus,
} from "../src/types";
import { PIPELINE_STEP_DEFINITIONS, VALID_TRANSITIONS } from "../src/types";

describe("VALID_TRANSITIONS", () => {
	test("idle can transition to running or waiting_for_dependencies", () => {
		expect(VALID_TRANSITIONS.idle).toEqual(["running", "waiting_for_dependencies"]);
	});

	test("running can transition to waiting_for_input, completed, error, paused", () => {
		expect(VALID_TRANSITIONS.running).toEqual([
			"waiting_for_input",
			"completed",
			"error",
			"paused",
		]);
	});

	test("paused can transition to running, cancelled, or error", () => {
		expect(VALID_TRANSITIONS.paused).toEqual(["running", "cancelled", "error"]);
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
			"waiting_for_dependencies",
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
	test("has exactly 13 steps in correct order", () => {
		const expectedNames: PipelineStepName[] = [
			"setup",
			"specify",
			"clarify",
			"plan",
			"tasks",
			"implement",
			"review",
			"implement-review",
			"commit-push-pr",
			"monitor-ci",
			"fix-ci",
			"merge-pr",
			"sync-repo",
		];
		expect(PIPELINE_STEP_DEFINITIONS.map((s) => s.name)).toEqual(expectedNames);
	});

	test("every step has a non-empty displayName", () => {
		for (const step of PIPELINE_STEP_DEFINITIONS) {
			expect(step.displayName.length).toBeGreaterThan(0);
		}
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

describe("MergeCycle shape", () => {
	test("a valid MergeCycle can be constructed", () => {
		const cycle: MergeCycle = {
			attempt: 0,
			maxAttempts: 3,
		};
		expect(cycle.attempt).toBe(0);
		expect(cycle.maxAttempts).toBe(3);
	});
});

describe("MergeResult shape", () => {
	test("a successful merge result", () => {
		const result: MergeResult = {
			merged: true,
			alreadyMerged: false,
			conflict: false,
			error: null,
		};
		expect(result.merged).toBe(true);
		expect(result.error).toBeNull();
	});

	test("a conflict merge result", () => {
		const result: MergeResult = {
			merged: false,
			alreadyMerged: false,
			conflict: true,
			error: null,
		};
		expect(result.conflict).toBe(true);
	});

	test("an error merge result", () => {
		const result: MergeResult = {
			merged: false,
			alreadyMerged: false,
			conflict: false,
			error: "Permission denied",
		};
		expect(result.error).toBe("Permission denied");
	});
});

describe("SyncResult shape", () => {
	test("a successful sync result", () => {
		const result: SyncResult = {
			pulled: true,
			skipped: false,
			worktreeRemoved: true,
			warning: null,
		};
		expect(result.pulled).toBe(true);
		expect(result.worktreeRemoved).toBe(true);
	});

	test("a skipped sync result with warning", () => {
		const result: SyncResult = {
			pulled: false,
			skipped: true,
			worktreeRemoved: true,
			warning: "Uncommitted changes detected",
		};
		expect(result.skipped).toBe(true);
		expect(result.warning).toBe("Uncommitted changes detected");
	});
});
