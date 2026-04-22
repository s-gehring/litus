// Full projection: WorkflowState (+ streamed output/tools history) →
// RunScreenModel. Kept separate from run-screen-model.ts so the model file
// stays a pure type-declaration + state-mapping helper.

import type {
	AppConfig,
	OutputEntry,
	ToolUsage,
	WorkflowClientState,
	WorkflowState,
} from "../../../types";
import type { LogEvent } from "./log-kind-classifier";
import { classifyLine } from "./log-kind-classifier";
import {
	type RunScreenModel,
	stepStateFromStatus,
	taskStateFromStatus,
	taskTypeFromWorkflow,
} from "./run-screen-model";
import {
	EDIT_TOOLS,
	projectTouchedFiles,
	READ_TOOLS,
	toolUsagesToLogItems,
} from "./touched-files-projector";

// Mapping between the segmented picker's display IDs and full Anthropic
// model IDs persisted in `AppConfig.models`. The picker's UI surface is
// `haiku-4 | sonnet-4.5 | opus-4.7`; the CLI accepts the full dated ID.
const FULL_MODEL_IDS: Record<"haiku-4" | "sonnet-4.5" | "opus-4.7", string> = {
	"haiku-4": "claude-haiku-4-5-20251001",
	"sonnet-4.5": "claude-sonnet-4-5",
	"opus-4.7": "claude-opus-4-7",
};

export function displayToFullModelId(display: string): string {
	const key = display as keyof typeof FULL_MODEL_IDS;
	return FULL_MODEL_IDS[key] ?? display;
}

/**
 * Map a full Anthropic model id to the segmented picker's display id. Returns
 * `null` when the id does not match any known display bucket, so the picker
 * can paint no selection and avoid silently coercing a custom id onto Sonnet
 * 4.5 on the next click (§2.4, FR-027 edge case).
 */
export function fullToDisplayModelId(full: string): "haiku-4" | "sonnet-4.5" | "opus-4.7" | null {
	if (/haiku-4/i.test(full)) return "haiku-4";
	if (/opus-4/i.test(full)) return "opus-4.7";
	if (/sonnet-4/i.test(full)) return "sonnet-4.5";
	return null;
}

export interface ProjectOptions {
	/** Current server config (for model/effort readout). Null while not loaded. */
	config: AppConfig | null;
}

function configModelFor(
	wf: WorkflowState,
	config: AppConfig | null,
): "haiku-4" | "sonnet-4.5" | "opus-4.7" | null {
	if (!config) return null;
	// Use the "implement" slot for quickfix / "specify" for spec as the current
	// representative per-type config (FR-027 allows reusing existing endpoints;
	// AppConfig is keyed by step rather than type).
	const m = wf.workflowKind === "quick-fix" ? config.models.implement : config.models.specify;
	if (!m || m.length === 0) return null;
	return fullToDisplayModelId(m);
}

function configEffortFor(
	wf: WorkflowState,
	config: AppConfig | null,
): "low" | "medium" | "high" | "xhigh" | "max" {
	if (!config) return "medium";
	const e = wf.workflowKind === "quick-fix" ? config.efforts.implement : config.efforts.specify;
	if (e === "low" || e === "medium" || e === "high" || e === "xhigh" || e === "max") return e;
	return "medium";
}

function outputEntriesToLogEvents(entries: readonly OutputEntry[]): LogEvent[] {
	const events: LogEvent[] = [];
	for (const row of entries) {
		if (row.kind === "text") {
			events.push(classifyLine(row.text, row.logKind));
		} else if (row.kind === "tools") {
			events.push({ kind: "toolstrip", items: toolUsagesToLogItems(row.tools) });
		}
	}
	return events;
}

/**
 * The current-step buffer is the live, streaming-message source
 * (`entry.outputLines` — pushed to by the client on every `workflow:output` /
 * `workflow:tools` message). For past steps, `step.outputLog` is the
 * server's persisted record. Using `outputLines` for the current step
 * closes the gap documented in the code-review §1.1 (the log console
 * previously only refreshed on the lower-frequency `workflow:state`
 * rebroadcasts).
 */
function currentStepSource(
	step: WorkflowState["steps"][number],
	outputLines: readonly OutputEntry[],
): readonly OutputEntry[] {
	// Streaming path: client appends to `entry.outputLines` on each
	// `workflow:output` / `workflow:tools` message and resets it on
	// `workflow:step-change`. Prefer it when non-empty; fall back to the
	// server-side `step.outputLog` snapshot otherwise (useful for projection
	// tests, and for the brief window between mount and the first stream
	// event when only a historical snapshot is available).
	if (outputLines.length > 0) return outputLines;
	return step.outputLog ?? [];
}

function projectLogEvents(entry: WorkflowClientState): LogEvent[] {
	const events: LogEvent[] = [];
	const currentIdx = entry.state.currentStepIndex;
	for (let i = 0; i < entry.state.steps.length; i++) {
		const step = entry.state.steps[i];
		const source =
			i === currentIdx ? currentStepSource(step, entry.outputLines) : (step.outputLog ?? []);
		events.push(...outputEntriesToLogEvents(source));
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

function lastWritableIndex(events: readonly LogEvent[]): number | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const kind = events[i].kind;
		if (kind === "out" || kind === "assistant" || kind === "cmd") return i;
	}
	return null;
}

/**
 * Running step: elapsed since `startedAt` (per data-model §5, "computed
 * from `history[]` for the running step"). Completed step: span between
 * `startedAt` and `completedAt`. Otherwise undefined — the stepper reads
 * `durationMs != null` to decide whether to render the duration row.
 */
function computeStepDurationMs(
	step: WorkflowState["steps"][number],
	now: number,
): number | undefined {
	if (!step.startedAt) return undefined;
	const start = new Date(step.startedAt).getTime();
	if (Number.isNaN(start)) return undefined;
	if (step.status === "running") return Math.max(0, now - start);
	if (step.completedAt) {
		const end = new Date(step.completedAt).getTime();
		if (!Number.isNaN(end)) return Math.max(0, end - start);
	}
	return undefined;
}

function aggregateTools(entry: WorkflowClientState): ToolUsage[] {
	const all: ToolUsage[] = [];
	const currentIdx = entry.state.currentStepIndex;
	for (let i = 0; i < entry.state.steps.length; i++) {
		const step = entry.state.steps[i];
		const source =
			i === currentIdx ? currentStepSource(step, entry.outputLines) : (step.outputLog ?? []);
		for (const row of source) {
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
		reads: allTools.filter((t) => READ_TOOLS.has(t.name)).length,
		edits: allTools.filter((t) => EDIT_TOOLS.has(t.name)).length,
	};
	// Anchor the caret on the last *text* event (§2.8). A trailing toolstrip
	// is not something the model is "currently writing into", so the caret
	// would otherwise park itself after an icon strip rather than on an open
	// assistant/out/cmd line.
	const writingLineIndex = state === "running" ? lastWritableIndex(events) : null;

	const now = Date.now();
	const pipeline = {
		type,
		steps: wf.steps.map((s) => ({
			name: s.displayName,
			state: stepStateFromStatus(s.status),
			durationMs: computeStepDurationMs(s, now),
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
			claudeMdLoaded: false, // TODO: infer from setup-step artifact per data-model.md §9
			skills: [],
		},
		touched: projectTouchedFiles(allTools),
		upcoming: upcomingStepNames(wf),
	};
}
