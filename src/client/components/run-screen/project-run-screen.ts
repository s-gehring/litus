// Full projection: WorkflowState (+ streamed output/tools history) →
// RunScreenModel. Kept separate from run-screen-model.ts so the model file
// stays a pure type-declaration + state-mapping helper.

import type { AppConfig, WorkflowClientState, WorkflowState } from "../../../types";
import type { LogEvent } from "./log-kind-classifier";
import { classifyLine } from "./log-kind-classifier";
import {
	type RunScreenModel,
	stepStateFromStatus,
	taskStateFromStatus,
	taskTypeFromWorkflow,
} from "./run-screen-model";
import { projectTouchedFiles, toolUsagesToLogItems } from "./touched-files-projector";

export interface ProjectOptions {
	/** Current server config (for model/effort readout). Null while not loaded. */
	config: AppConfig | null;
}

function configModelFor(wf: WorkflowState, config: AppConfig | null): string {
	if (!config) return "sonnet-4.5";
	// Use the "implement" slot for quickfix / "specify" for spec as the current
	// representative per-type config (FR-027 allows reusing existing endpoints;
	// AppConfig is keyed by step rather than type).
	const m = wf.workflowKind === "quick-fix" ? config.models.implement : config.models.specify;
	return m && m.length > 0 ? m : "sonnet-4.5";
}

function configEffortFor(wf: WorkflowState, config: AppConfig | null): "low" | "medium" | "high" {
	if (!config) return "medium";
	const e = wf.workflowKind === "quick-fix" ? config.efforts.implement : config.efforts.specify;
	if (e === "low" || e === "medium" || e === "high") return e;
	return "medium";
}

function projectLogEvents(entry: WorkflowClientState): LogEvent[] {
	const events: LogEvent[] = [];
	for (const out of entry.state.steps) {
		for (const row of out.outputLog ?? []) {
			if (row.kind === "text") {
				events.push(classifyLine(row.text));
			} else if (row.kind === "tools") {
				events.push({ kind: "toolstrip", items: toolUsagesToLogItems(row.tools) });
			}
		}
	}
	return events;
}

function currentStepDisplayName(wf: WorkflowState): string | null {
	const idx = wf.currentStepIndex;
	if (idx < 0 || idx >= wf.steps.length) return null;
	return wf.steps[idx]?.displayName ?? null;
}

function upcomingStepNames(wf: WorkflowState): string[] {
	const idx = wf.currentStepIndex;
	return wf.steps.slice(idx + 1).map((s) => s.displayName);
}

function aggregateTools(entry: WorkflowClientState) {
	const all: import("../../../types").ToolUsage[] = [];
	for (const step of entry.state.steps) {
		for (const row of step.outputLog ?? []) {
			if (row.kind === "tools") all.push(...row.tools);
		}
	}
	return all;
}

export function projectRunScreenModel(
	entry: WorkflowClientState,
	opts: ProjectOptions,
): RunScreenModel {
	const wf = entry.state;
	const type = taskTypeFromWorkflow(wf);
	const state = taskStateFromStatus(wf.status);

	const allTools = aggregateTools(entry);
	const events = projectLogEvents(entry);
	const counters = {
		toolCalls: allTools.length,
		reads: allTools.filter((t) => /read/i.test(t.name)).length,
		edits: allTools.filter((t) => /edit|write/i.test(t.name)).length,
	};
	const writingLineIndex = state === "running" && events.length > 0 ? events.length - 1 : null;

	const pipeline = {
		type,
		steps: wf.steps.map((s) => ({
			name: s.displayName,
			state: stepStateFromStatus(s.status),
		})),
		currentIndex: wf.currentStepIndex,
	};

	return {
		id: wf.id,
		type,
		title: wf.summary || wf.specification.slice(0, 80) || wf.id,
		state,
		paused: wf.status === "paused",
		header: {
			createdAt: new Date(wf.createdAt).getTime(),
			branch: wf.featureBranch,
			worktree: wf.worktreePath,
			base: null,
			description: wf.specification || null,
		},
		pipeline,
		config: {
			model: configModelFor(wf, opts.config),
			effort: configEffortFor(wf, opts.config),
			metrics: { tokens: null, spendUsd: null },
		},
		log: {
			events,
			writingLineIndex,
			currentStep: currentStepDisplayName(wf),
			counters,
		},
		env: {
			worktree: wf.worktreePath,
			python: null,
			node: null,
			pnpm: null,
			claudeMdLoaded: false,
			skills: [],
		},
		touched: projectTouchedFiles(allTools),
		upcoming: upcomingStepNames(wf),
	};
}
