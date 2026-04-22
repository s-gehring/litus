import { expect } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config-store";
import type { Workflow, WorkflowState } from "../src/types";
import { getStepDefinitionsForKind } from "../src/types";

export function makeWorkflow(overrides?: Partial<Workflow>): Workflow {
	const now = new Date().toISOString();
	return {
		id: overrides?.id ?? `wf-${Date.now()}`,
		workflowKind: "spec",
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
		steps: getStepDefinitionsForKind("spec").map((def) => ({
			name: def.name,
			displayName: def.displayName,
			status: "pending" as const,
			prompt: def.prompt,
			sessionId: null,
			output: "",
			outputLog: [],
			error: null,
			startedAt: null,
			completedAt: null,
			pid: null,
			history: [],
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
		activeInvocation: null,
		managedRepo: null,
		error: null,
		createdAt: now,
		updatedAt: now,
		archived: false,
		archivedAt: null,
		...overrides,
	};
}

export function makeWorkflowState(overrides?: Partial<WorkflowState>): WorkflowState {
	return {
		id: overrides?.id ?? `wf-${Date.now()}`,
		workflowKind: "spec",
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
		activeInvocation: null,
		managedRepo: null,
		error: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		archived: false,
		archivedAt: null,
		...overrides,
	};
}

export function assertDefined<T>(value: T | null | undefined): asserts value is T {
	expect(value).not.toBeNull();
	expect(value).toBeDefined();
}
