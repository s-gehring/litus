import { expect } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config-store";
import type { Workflow, WorkflowState } from "../src/types";
import { PIPELINE_STEP_DEFINITIONS } from "../src/types";

export function makeWorkflow(overrides?: Partial<Workflow>): Workflow {
	const now = new Date().toISOString();
	return {
		id: overrides?.id ?? `wf-${Date.now()}`,
		specification: "Build a feature",
		status: "idle",
		targetRepository: "/tmp/test-repo",
		worktreePath: "/tmp/test-worktree",
		worktreeBranch: "tmp-test0001",
		featureBranch: null,
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
			maxIterations: DEFAULT_CONFIG.limits.reviewCycleMaxIterations,
			lastSeverity: null,
		},
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
		targetRepository: "/tmp/test-repo",
		worktreePath: "/tmp/test",
		worktreeBranch: "tmp-test0001",
		featureBranch: null,
		summary: "",
		stepSummary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: [],
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
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

export function assertDefined<T>(value: T | null | undefined): asserts value is T {
	expect(value).not.toBeNull();
	expect(value).toBeDefined();
}
