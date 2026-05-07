// Pipeline-step taxonomy. Wire-relevant type aliases (PipelineStepName,
// PipelineStepStatus, WorkflowStatus, PipelineStep, PipelineStepRun,
// ArtifactsStepOutcome) live in `@litus/protocol`. Server-internal
// runtime constants and helpers stay here.

import type { PipelineStepName, WorkflowStatus, WorkflowKind } from "@litus/protocol";

export type {
	ArtifactsStepOutcome,
	PipelineStep,
	PipelineStepName,
	PipelineStepRun,
	PipelineStepStatus,
	WorkflowStatus,
} from "@litus/protocol";

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

export const PIPELINE_STEP_DEFINITIONS: ReadonlyArray<{
	name: PipelineStepName;
	displayName: string;
	prompt: string;
}> = [
	{ name: "setup", displayName: "Setup", prompt: "" },
	{ name: "specify", displayName: "Specifying", prompt: "/speckit-specify" },
	{ name: "clarify", displayName: "Clarifying", prompt: "/speckit-clarify" },
	{
		name: "plan",
		displayName: "Planning",
		prompt: `/speckit-plan

Additional directions:
- Do not extend scope beyond what the specification calls for. Plan exactly what is specified, nothing more.
- The entire plan must fit within a single pull request — do not split work across multiple PRs.
- The plan must not require any manual steps from the user. Every action must be performable by an automated agent.`,
	},
	{ name: "tasks", displayName: "Generating Tasks", prompt: "/speckit-tasks" },
	{
		name: "implement",
		displayName: "Implementing",
		prompt: `/speckit-implement

Additional directions:
- Do not extend scope beyond the specification. Implement exactly what is specified — no extra features, refactors, or speculative work.
- Only ask the user a question if you genuinely need an answer to proceed; otherwise make a reasonable decision and continue.
- When you are done, do not end your output with a question. State what was implemented and exit.`,
	},
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
	{ name: "decompose", displayName: "Decomposing Question", prompt: "" },
	{ name: "research-aspect", displayName: "Researching Aspect", prompt: "" },
	{ name: "synthesize", displayName: "Synthesizing Answer", prompt: "" },
	{ name: "answer", displayName: "Answer", prompt: "" },
	{ name: "finalize", displayName: "Finalizing", prompt: "" },
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

const ASK_QUESTION_ORDER: ReadonlyArray<PipelineStepName> = [
	"setup",
	"decompose",
	"research-aspect",
	"synthesize",
	"answer",
	"finalize",
];

const STEP_DEFINITION_BY_NAME: ReadonlyMap<
	PipelineStepName,
	{ name: PipelineStepName; displayName: string; prompt: string }
> = new Map(PIPELINE_STEP_DEFINITIONS.map((d) => [d.name, d]));

export function getStepDefinitionByName(
	name: PipelineStepName,
): { name: PipelineStepName; displayName: string; prompt: string } | undefined {
	return STEP_DEFINITION_BY_NAME.get(name);
}

export function getStepDefinitionsForKind(
	kind: WorkflowKind,
): ReadonlyArray<{ name: PipelineStepName; displayName: string; prompt: string }> {
	const order =
		kind === "quick-fix"
			? QUICK_FIX_ORDER
			: kind === "ask-question"
				? ASK_QUESTION_ORDER
				: SPEC_ORDER;
	return order.map((name) => {
		const def = STEP_DEFINITION_BY_NAME.get(name);
		if (!def) throw new Error(`Missing step definition for ${name}`);
		return def;
	});
}

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
	DECOMPOSE: "decompose",
	RESEARCH_ASPECT: "research-aspect",
	SYNTHESIZE: "synthesize",
	ANSWER: "answer",
	FINALIZE: "finalize",
} as const satisfies Record<string, PipelineStepName>;
