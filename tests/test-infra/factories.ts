import { DEFAULT_CONFIG } from "../../src/config-store";
import type {
	AppConfig,
	PersistedEpic,
	PipelineStep,
	Workflow,
	WorkflowStatus,
} from "../../src/types";
import { makeWorkflow } from "../helpers";

/** Create a complete AppConfig with sensible defaults, accepts partial overrides */
export function makeAppConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		...structuredClone(DEFAULT_CONFIG),
		...overrides,
	};
}

let epicCounter = 0;

/** Reset the epic counter (call in beforeEach to get deterministic IDs) */
export function resetEpicCounter(): void {
	epicCounter = 0;
}

/** Create a complete PersistedEpic with sensible defaults, accepts partial overrides */
export function makePersistedEpic(overrides?: Partial<PersistedEpic>): PersistedEpic {
	return {
		epicId: `epic-${++epicCounter}`,
		description: "Test epic description",
		status: "completed",
		title: "Test Epic",
		workflowIds: [],
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		errorMessage: null,
		infeasibleNotes: null,
		analysisSummary: null,
		...overrides,
	};
}

/** Create a complete PipelineStep with sensible defaults, accepts partial overrides */
export function makePipelineStep(overrides?: Partial<PipelineStep>): PipelineStep {
	return {
		name: "implement",
		displayName: "Implementing",
		status: "pending",
		prompt: "/speckit-implement",
		sessionId: null,
		output: "",
		error: null,
		startedAt: null,
		completedAt: null,
		pid: null,
		history: [],
		...overrides,
	};
}

export interface WorkflowStatusOptions {
	stepName?: string;
	error?: string;
}

/**
 * Create a Workflow in a specific status state with correctly configured steps.
 * Delegates to makeWorkflow() from tests/helpers.ts.
 */
export function makeWorkflowWithStatus(
	status: WorkflowStatus,
	options?: WorkflowStatusOptions,
): Workflow {
	const base = makeWorkflow({ status });
	const steps = base.steps;
	const now = new Date().toISOString();

	const targetStepName = options?.stepName;
	const targetIndex = targetStepName ? steps.findIndex((s) => s.name === targetStepName) : -1;

	if (targetStepName && targetIndex === -1) {
		throw new Error(
			`Step '${targetStepName}' not found. Available: ${steps.map((s) => s.name).join(", ")}`,
		);
	}

	switch (status) {
		case "idle":
			// All steps pending
			for (const step of steps) {
				step.status = "pending";
			}
			break;

		case "running": {
			const runIdx = targetIndex >= 0 ? targetIndex : 0;
			for (let i = 0; i < steps.length; i++) {
				if (i < runIdx) {
					steps[i].status = "completed";
					steps[i].startedAt = now;
					steps[i].completedAt = now;
				} else if (i === runIdx) {
					steps[i].status = "running";
					steps[i].startedAt = now;
				} else {
					steps[i].status = "pending";
				}
			}
			base.currentStepIndex = runIdx;
			break;
		}

		case "completed":
			for (const step of steps) {
				step.status = "completed";
				step.startedAt = now;
				step.completedAt = now;
			}
			base.currentStepIndex = steps.length - 1;
			break;

		case "error": {
			const errIdx = targetIndex >= 0 ? targetIndex : 0;
			for (let i = 0; i < steps.length; i++) {
				if (i < errIdx) {
					steps[i].status = "completed";
					steps[i].startedAt = now;
					steps[i].completedAt = now;
				} else if (i === errIdx) {
					steps[i].status = "error";
					steps[i].startedAt = now;
					steps[i].error = options?.error ?? "Unknown error";
				} else {
					steps[i].status = "pending";
				}
			}
			base.currentStepIndex = errIdx;
			break;
		}

		case "paused": {
			const pauseIdx = targetIndex >= 0 ? targetIndex : 0;
			for (let i = 0; i < steps.length; i++) {
				if (i < pauseIdx) {
					steps[i].status = "completed";
					steps[i].startedAt = now;
					steps[i].completedAt = now;
				} else if (i === pauseIdx) {
					steps[i].status = "paused";
					steps[i].startedAt = now;
				} else {
					steps[i].status = "pending";
				}
			}
			base.currentStepIndex = pauseIdx;
			break;
		}

		default:
			// For other statuses (waiting_for_input, etc.), leave defaults
			break;
	}

	return base;
}

/** Convenience: create a completed workflow */
export function makeCompletedWorkflow(): Workflow {
	return makeWorkflowWithStatus("completed");
}

/** Convenience: create a failed workflow at an optional step */
export function makeFailedWorkflow(stepName?: string, error?: string): Workflow {
	return makeWorkflowWithStatus("error", { stepName, error });
}

/** Convenience: create a running workflow at an optional step */
export function makeRunningWorkflow(stepName?: string): Workflow {
	return makeWorkflowWithStatus("running", { stepName });
}
