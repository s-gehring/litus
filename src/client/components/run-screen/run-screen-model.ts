// Projection from WorkflowState → the models each run-screen sub-component
// consumes (data-model §4). Keep pure: no DOM, no side effects, no caching.

import type { WorkflowState, WorkflowStatus } from "../../../types";
import type { TaskType } from "../../design-system/tokens";
import type { LogEvent } from "./log-kind-classifier";

export type TaskState = "queued" | "running" | "paused" | "done" | "blocked" | "error";

export interface PipelineStep {
	name: string;
	state: "done" | "running" | "queued" | "skip";
	durationMs?: number;
}

export interface PipelineStepperModel {
	type: TaskType;
	steps: PipelineStep[];
	currentIndex: number;
}

export interface ConfigRowModel {
	model: string;
	effort: "low" | "medium" | "high" | "xhigh" | "max";
	metrics: { tokens: number | null; spendUsd: number | null };
}

export interface LogConsoleModel {
	events: LogEvent[];
	writingLineIndex: number | null;
	currentStep: string | null;
	counters: { toolCalls: number; reads: number; edits: number };
}

export interface RunScreenEnvironment {
	worktree: string | null;
	python: string | null;
	node: string | null;
	pnpm: string | null;
	claudeMdLoaded: boolean;
	skills: Array<{ name: string; count: number }>;
}

export interface TouchedFile {
	path: string;
	kind: "edit" | "new" | "read";
}

export interface RunScreenModel {
	id: string;
	type: TaskType;
	title: string;
	state: TaskState;
	paused: boolean;
	header: {
		createdAt: number;
		branch: string | null;
		worktree: string | null;
		base: string | null;
		description: string | null;
	};
	pipeline: PipelineStepperModel;
	config: ConfigRowModel;
	log: LogConsoleModel;
	env: RunScreenEnvironment;
	touched: TouchedFile[];
	upcoming: string[];
}

export function taskTypeFromWorkflow(wf: WorkflowState): TaskType {
	if (wf.epicId) return "epic";
	return wf.workflowKind === "quick-fix" ? "quickfix" : "spec";
}

export function taskStateFromStatus(status: WorkflowStatus): TaskState {
	switch (status) {
		case "running":
			return "running";
		case "waiting_for_input":
		case "paused":
			return "paused";
		case "completed":
			return "done";
		case "error":
		case "aborted":
			return "error";
		case "waiting_for_dependencies":
			return "blocked";
		default:
			return "queued";
	}
}

/**
 * Map a server-side PipelineStep status into the stepper's state enum.
 * `error` / `aborted` / `paused` / `waiting_for_input` / `pending` collapse
 * into `queued`. The stepper currently renders no dedicated error row — a
 * future spec will add that affordance; until then the UI hides error state
 * entirely rather than lying with queued-colour styling (§2.10).
 */
export function stepStateFromStatus(
	status: WorkflowState["steps"][number]["status"],
): PipelineStep["state"] {
	switch (status) {
		case "completed":
			return "done";
		case "running":
			return "running";
		default:
			return "queued";
	}
}
