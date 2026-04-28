// ── Pipeline-step taxonomy ─────────────────────────────────
//
// Names, ordering, status, definitions, and per-step run records for the
// workflow pipeline. The single source of truth for what steps exist, what
// they're called in the UI, and what prompt template feeds the agent. Keep
// the workflow status enum here too — it's tightly coupled to step lifecycle.

import type { OutputEntry, WorkflowKind } from "./types";

// Workflow status enum
export type WorkflowStatus =
	| "idle"
	| "running"
	| "waiting_for_input"
	| "waiting_for_dependencies"
	| "paused"
	| "completed"
	| "aborted"
	| "error";

// Valid state transitions.
//
// NOTE: `resetWorkflow` (src/workflow-engine.ts) intentionally bypasses this
// table and sets `status = "idle"` directly. That path introduces two edges
// not listed here — `aborted → idle` and `error → idle` — which are only
// legal via the reset flow. `transition()` itself must continue to treat
// `aborted`/`error` as terminal with respect to `running`/`aborted` only.
export const VALID_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
	idle: ["running", "waiting_for_dependencies"],
	running: ["waiting_for_input", "completed", "error", "paused"],
	waiting_for_input: ["running", "aborted"],
	waiting_for_dependencies: ["running", "aborted"],
	paused: ["running", "aborted", "error"],
	completed: [],
	aborted: [],
	error: ["running", "aborted"],
};

// Pipeline step names in execution order
export type PipelineStepName =
	| "setup"
	| "specify"
	| "clarify"
	| "plan"
	| "tasks"
	| "implement"
	| "review"
	| "implement-review"
	| "artifacts"
	| "fix-implement"
	| "commit-push-pr"
	| "monitor-ci"
	| "fix-ci"
	| "feedback-implementer"
	| "merge-pr"
	| "sync-repo";

// Pipeline step status
export type PipelineStepStatus =
	| "pending"
	| "running"
	| "waiting_for_input"
	| "paused"
	| "completed"
	| "error";

// Archived run of a repeatable pipeline step. Created when `resetStep` is
// called on a step that already ran (`startedAt != null`). Immutable once
// appended; the only mutation is whole-entry removal when the global per-step
// output cap is exceeded.
export interface PipelineStepRun {
	runNumber: number;
	status: "completed" | "error" | "paused";
	output: string;
	// Structured log preserving text+tool interleaving. Empty for pre-migration runs.
	outputLog: OutputEntry[];
	error: string | null;
	startedAt: string;
	completedAt: string | null;
}

// Terminal outcome refinement for the `artifacts` step only. Distinguishes
// "LLM succeeded and at least one manifest-listed file was kept" from "LLM
// succeeded and declared zero artifacts" so the UI can render the two paths
// differently (FR-011). Null for all other steps and for artifacts runs that
// haven't terminated yet.
export type ArtifactsStepOutcome = "with-files" | "empty";

// Pipeline step entity
export interface PipelineStep {
	name: PipelineStepName;
	displayName: string;
	status: PipelineStepStatus;
	prompt: string;
	sessionId: string | null;
	output: string;
	// Structured log preserving text+tool interleaving. The `output` string
	// mirrors all text entries for parsers (`parseAgentResult`, `extractPrUrl`).
	outputLog: OutputEntry[];
	error: string | null;
	startedAt: string | null;
	completedAt: string | null;
	pid: number | null;
	history: PipelineStepRun[];
	outcome?: ArtifactsStepOutcome | null;
}

// Step definitions: name → display name and prompt template.
// Order here is NOT semantically meaningful — pipeline execution order is
// driven by `SPEC_ORDER` / `QUICK_FIX_ORDER` below. Consumers (`STEP`,
// `getStepDefinitionsForKind`) look up by name, not by position.
export const PIPELINE_STEP_DEFINITIONS: ReadonlyArray<{
	name: PipelineStepName;
	displayName: string;
	prompt: string;
}> = [
	{ name: "setup", displayName: "Setup", prompt: "" },
	{ name: "specify", displayName: "Specifying", prompt: "/speckit-specify" },
	{ name: "clarify", displayName: "Clarifying", prompt: "/speckit-clarify" },
	{ name: "plan", displayName: "Planning", prompt: "/speckit-plan" },
	{ name: "tasks", displayName: "Generating Tasks", prompt: "/speckit-tasks" },
	{ name: "implement", displayName: "Implementing", prompt: "/speckit-implement" },
	{ name: "review", displayName: "Reviewing", prompt: "/speckit-review" },
	{ name: "implement-review", displayName: "Fixing Review", prompt: "/speckit-implementreview" },
	{
		name: "artifacts",
		displayName: "Generating Artifacts",
		prompt: "",
	},
	{
		name: "commit-push-pr",
		displayName: "Creating PR",
		prompt:
			"Commit all uncommitted changes in atomic, Conventional-Commits-style commits on the current branch. DO NOT push, DO NOT run `git push`, and DO NOT run `gh pr create` — Litus will push and open the PR after you exit. DO NOT stage or commit CLAUDE.md; leave any CLAUDE.md edits uncommitted in the working tree. When you have finished committing the other changes, exit.",
	},
	{ name: "fix-implement", displayName: "Fix Implementation", prompt: "" },
	{ name: "monitor-ci", displayName: "Monitoring CI", prompt: "" },
	{ name: "fix-ci", displayName: "Fixing CI", prompt: "" },
	{ name: "feedback-implementer", displayName: "Applying Feedback", prompt: "" },
	{ name: "merge-pr", displayName: "Merging PR", prompt: "" },
	{ name: "sync-repo", displayName: "Syncing Repository", prompt: "" },
];

const SPEC_ORDER: ReadonlyArray<PipelineStepName> = [
	"setup",
	"specify",
	"clarify",
	"plan",
	"tasks",
	"implement",
	"review",
	"implement-review",
	"artifacts",
	"commit-push-pr",
	"monitor-ci",
	"fix-ci",
	"feedback-implementer",
	"merge-pr",
	"sync-repo",
];

const QUICK_FIX_ORDER: ReadonlyArray<PipelineStepName> = [
	"setup",
	"fix-implement",
	"commit-push-pr",
	"monitor-ci",
	"fix-ci",
	"feedback-implementer",
	"merge-pr",
	"sync-repo",
];

// Ordered step list for each workflow kind.
export function getStepDefinitionsForKind(
	kind: WorkflowKind,
): ReadonlyArray<{ name: PipelineStepName; displayName: string; prompt: string }> {
	const order = kind === "quick-fix" ? QUICK_FIX_ORDER : SPEC_ORDER;
	return order.map((name) => {
		const def = PIPELINE_STEP_DEFINITIONS.find((d) => d.name === name);
		if (!def) throw new Error(`Missing step definition for ${name}`);
		return def;
	});
}

// Typed step name constants — compile-time checked via `satisfies`
export const STEP = {
	SETUP: "setup",
	SPECIFY: "specify",
	CLARIFY: "clarify",
	PLAN: "plan",
	TASKS: "tasks",
	IMPLEMENT: "implement",
	REVIEW: "review",
	IMPLEMENT_REVIEW: "implement-review",
	ARTIFACTS: "artifacts",
	FIX_IMPLEMENT: "fix-implement",
	COMMIT_PUSH_PR: "commit-push-pr",
	MONITOR_CI: "monitor-ci",
	FIX_CI: "fix-ci",
	FEEDBACK_IMPLEMENTER: "feedback-implementer",
	MERGE_PR: "merge-pr",
	SYNC_REPO: "sync-repo",
} as const satisfies Record<string, PipelineStepName>;
