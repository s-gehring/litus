import { expect } from "bun:test";
import type { Workflow, WorkflowState } from "../src/types";
import { PIPELINE_STEP_DEFINITIONS, REVIEW_CYCLE_MAX_ITERATIONS } from "../src/types";

export function makeWorkflow(overrides?: Partial<Workflow>): Workflow {
	const now = new Date().toISOString();
	return {
		id: overrides?.id ?? `wf-${Date.now()}`,
		specification: "Build a feature",
		status: "idle",
		targetRepository: null,
		worktreePath: "/tmp/test-worktree",
		worktreeBranch: "crab-studio/test",
		summary: "",
		stepSummary: "",
		flavor: "",
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
		prUrl: null,
		activeWorkMs: 0,
		activeWorkStartedAt: null,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

export function makeWorkflowState(overrides?: Partial<WorkflowState>): WorkflowState {
	return {
		id: overrides?.id ?? `wf-${Date.now()}`,
		specification: "Build a feature",
		status: "idle",
		targetRepository: null,
		worktreePath: "/tmp/test",
		worktreeBranch: "crab-studio/test",
		summary: "",
		stepSummary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: [],
		currentStepIndex: 0,
		reviewCycle: { iteration: 1, maxIterations: 16, lastSeverity: null },
		prUrl: null,
		activeWorkMs: 0,
		activeWorkStartedAt: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

export function assertDefined<T>(value: T | null | undefined): asserts value is T {
	expect(value).not.toBeNull();
	expect(value).toBeDefined();
}
