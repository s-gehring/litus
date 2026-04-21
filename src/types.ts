// ── Utility types ─────────────────────────────────────────

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ── Config types ──────────────────────────────────────────

export interface ModelConfig {
	// Lightweight models (required, non-empty)
	questionDetection: string;
	reviewClassification: string;
	activitySummarization: string;
	specSummarization: string;
	// Workflow step models (optional, empty = use CLI default)
	epicDecomposition: string;
	mergeConflictResolution: string;
	ciFix: string;
	specify: string;
	clarify: string;
	plan: string;
	tasks: string;
	implement: string;
	review: string;
	implementReview: string;
	commitPushPr: string;
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface EffortConfig {
	// Lightweight models — default "low"
	questionDetection: EffortLevel;
	reviewClassification: EffortLevel;
	activitySummarization: EffortLevel;
	specSummarization: EffortLevel;
	// Workflow step models — default "medium"
	epicDecomposition: EffortLevel;
	mergeConflictResolution: EffortLevel;
	ciFix: EffortLevel;
	specify: EffortLevel;
	clarify: EffortLevel;
	plan: EffortLevel;
	tasks: EffortLevel;
	implement: EffortLevel;
	review: EffortLevel;
	implementReview: EffortLevel;
	commitPushPr: EffortLevel;
}

export interface PromptConfig {
	questionDetection: string;
	reviewClassification: string;
	activitySummarization: string;
	specSummarization: string;
	mergeConflictResolution: string;
	ciFixInstruction: string;
	epicDecomposition: string;
	feedbackImplementerInstruction: string;
}

export interface LimitConfig {
	reviewCycleMaxIterations: number;
	ciFixMaxAttempts: number;
	mergeMaxAttempts: number;
	maxJsonRetries: number;
}

export interface TimingConfig {
	ciGlobalTimeoutMs: number;
	ciPollIntervalMs: number;
	activitySummaryIntervalMs: number;
	rateLimitBackoffMs: number;
	maxCiLogLength: number;
	maxClientOutputLines: number;
	epicTimeoutMs: number;
	cliIdleTimeoutMs: number;
}

export type AutoMode = "manual" | "normal" | "full-auto";

export function shouldAutoAnswer(mode: AutoMode): boolean {
	return mode === "full-auto";
}

export function shouldPauseBeforeMerge(mode: AutoMode): boolean {
	return mode === "manual";
}

export interface AppConfig {
	models: ModelConfig;
	efforts: EffortConfig;
	prompts: PromptConfig;
	limits: LimitConfig;
	timing: TimingConfig;
	autoMode: AutoMode;
}

export interface PromptVariableInfo {
	name: string;
	description: string;
}

export interface NumericSettingMeta {
	key: string;
	label: string;
	description: string;
	min: number;
	defaultValue: number;
	unit?: string;
}

export interface ConfigValidationError {
	path: string;
	message: string;
	value: unknown;
}

export interface ConfigWarning {
	path: string;
	missingVariables: string[];
	message: string;
}

// ── Audit event types ─────────────────────────────────────

// Audit event types
export type AuditEventType =
	| "pipeline_start"
	| "pipeline_end"
	| "query"
	| "answer"
	| "commit"
	| "workflow.reset";

// Payload persisted as a JSONL record when a workflow is reset via the retry-
// workflow action. Matches contracts/audit-workflow-reset.md. Lives alongside
// the run-scoped `AuditEvent` records in the same per-pipeline file, but is
// produced outside a pipeline run (no `runId` / `sequenceNumber`).
export interface WorkflowResetAuditEvent {
	type: "workflow.reset";
	timestamp: string;
	actor: string;
	workflowId: string;
	epicId: string | null;
	branch: string;
	worktreePath: string;
	artifactCount: number;
	partialFailure: boolean;
}

export interface AuditEvent {
	timestamp: string;
	eventType: AuditEventType;
	runId: string;
	pipelineName: string;
	branch: string | null;
	commitHash: string | null;
	stepName: string | null;
	sequenceNumber: number;
	content: string | null;
	metadata: Record<string, unknown> | null;
}

export interface AuditConfig {
	auditDir?: string;
}

// ── Epic aggregated types ────────────────────────────────

export type EpicAggregatedStatus =
	| "idle"
	| "running"
	| "paused"
	| "waiting"
	| "error"
	| "in_progress"
	| "completed";

export interface EpicAggregatedState {
	epicId: string;
	title: string;
	status: EpicAggregatedStatus;
	progress: { completed: number; total: number };
	startDate: string;
	activeWorkMs: number;
	activeWorkStartedAt: string | null;
	childWorkflowIds: string[];
}

// ── Epic types ───────────────────────────────────────────

export type EpicDependencyStatus = "satisfied" | "waiting" | "blocked" | "overridden";

export interface EpicSpecEntry {
	id: string;
	title: string;
	description: string;
	dependencies: string[];
}

export interface EpicAnalysisResult {
	title: string;
	specs: EpicSpecEntry[];
	infeasibleNotes: string | null;
	summary: string | null;
}

export interface DependencyGraph {
	nodes: string[];
	edges: Map<string, string[]>;
	inDegree: Map<string, number>;
}

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

// Question entity
export interface Question {
	id: string;
	content: string;
	detectedAt: string;
}

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
	| "fix-implement"
	| "commit-push-pr"
	| "monitor-ci"
	| "fix-ci"
	| "feedback-implementer"
	| "merge-pr"
	| "sync-repo";

// Workflow kind: "spec" is the existing Speckit pipeline; "quick-fix" is the
// direct-implementation pipeline driven by the user's fix description.
export type WorkflowKind = "spec" | "quick-fix";

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
}

// Lightweight metadata for fast workflow listing without loading full state
export interface WorkflowIndexEntry {
	id: string;
	workflowKind: WorkflowKind;
	branch: string;
	status: WorkflowStatus;
	summary: string;
	epicId: string | null;
	createdAt: string;
	updatedAt: string;
}

// CI check result from gh pr checks
export interface CiCheckResult {
	name: string;
	state: string;
	bucket: string;
	link: string;
}

// Aggregated failure info for a single failed check run
export interface CiFailureLog {
	checkName: string;
	runId: string;
	logs: string;
}

// CI monitor/fix loop tracker
export interface CiCycle {
	attempt: number;
	maxAttempts: number;
	monitorStartedAt: string | null;
	globalTimeoutMs: number;
	lastCheckResults: CiCheckResult[];
	failureLogs: CiFailureLog[];
}

// Merge-conflict-resolution loop tracker
export interface MergeCycle {
	attempt: number;
	maxAttempts: number;
}

// Result from PR merger module (not persisted)
export interface MergeResult {
	merged: boolean;
	alreadyMerged: boolean;
	conflict: boolean;
	error: string | null;
}

// Result from repo syncer module (not persisted)
export interface SyncResult {
	pulled: boolean;
	skipped: boolean;
	worktreeRemoved: boolean;
	warning: string | null;
}

// Setup check types
export interface SetupCheckResult {
	name: string;
	passed: boolean;
	error?: string;
	required: boolean;
}

export interface SetupResult {
	passed: boolean;
	checks: SetupCheckResult[];
	requiredFailures: SetupCheckResult[];
	optionalWarnings: SetupCheckResult[];
}

// Review severity classification
export type ReviewSeverity = "critical" | "major" | "minor" | "trivial" | "nit";

// Review cycle tracker
export interface ReviewCycle {
	iteration: number;
	maxIterations: number;
	lastSeverity: ReviewSeverity | null;
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
		name: "commit-push-pr",
		displayName: "Creating PR",
		prompt:
			"Commit all uncommitted changes in atomic commits. Then push the branch and open a PR using gh, which is already authenticated for the current repository.",
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
	FIX_IMPLEMENT: "fix-implement",
	COMMIT_PUSH_PR: "commit-push-pr",
	MONITOR_CI: "monitor-ci",
	FIX_CI: "fix-ci",
	FEEDBACK_IMPLEMENTER: "feedback-implementer",
	MERGE_PR: "merge-pr",
	SYNC_REPO: "sync-repo",
} as const satisfies Record<string, PipelineStepName>;

// Delta buffer flush timeout used across CLI stream consumers
export const DELTA_FLUSH_TIMEOUT_MS = 50;

// Manual-mode feedback loop: per-iteration outcome of a feedback-implementer run
export type FeedbackOutcomeValue = "success" | "no changes" | "failed" | "aborted";

export interface FeedbackOutcomeWarning {
	kind: "pr_description_update_failed";
	message: string;
}

export interface FeedbackOutcome {
	value: FeedbackOutcomeValue;
	summary: string;
	commitRefs: string[];
	warnings: FeedbackOutcomeWarning[];
}

export interface FeedbackEntry {
	id: string;
	iteration: number;
	text: string;
	submittedAt: string;
	submittedAtStepName: PipelineStepName;
	outcome: FeedbackOutcome | null;
}

// AI invocation role — "main" is substantive step work; "helper" is admin/classification
export type AIInvocationRole = "main" | "helper";

// Currently running main AI invocation for a workflow (null when none)
export interface ActiveAIInvocation {
	model: string;
	effort: EffortLevel | null;
	stepName: PipelineStepName;
	startedAt: string;
	role: "main";
}

// Workflow entity (extended with pipeline fields)
export interface Workflow {
	id: string;
	workflowKind: WorkflowKind;
	specification: string;
	status: WorkflowStatus;
	targetRepository: string | null;
	worktreePath: string | null;
	worktreeBranch: string;
	featureBranch: string | null;
	summary: string;
	stepSummary: string;
	flavor: string;
	pendingQuestion: Question | null;
	lastOutput: string;
	steps: PipelineStep[];
	currentStepIndex: number;
	reviewCycle: ReviewCycle;
	ciCycle: CiCycle;
	mergeCycle: MergeCycle;
	prUrl: string | null;
	epicId: string | null;
	epicTitle: string | null;
	epicDependencies: string[];
	epicDependencyStatus: EpicDependencyStatus | null;
	epicAnalysisMs: number;
	activeWorkMs: number;
	activeWorkStartedAt: string | null;
	feedbackEntries: FeedbackEntry[];
	/**
	 * Git HEAD SHA captured when the current commit-producing iteration started.
	 * Used by both `feedback-implementer` (spec flow) and `fix-implement`
	 * (quick-fix flow): each writes the pre-run HEAD here and, on completion,
	 * compares against the current HEAD to either count new commits
	 * (feedback-implementer) or detect an empty diff (fix-implement). Persisted
	 * on the workflow so pause→resume (including across a server restart) counts
	 * commits from the original pre-run head rather than re-snapshotting and
	 * losing commits that already landed. Null when no iteration is in flight.
	 */
	feedbackPreRunHead: string | null;
	activeInvocation: ActiveAIInvocation | null;
	managedRepo: { owner: string; repo: string } | null;
	/**
	 * Workflow-level error message (distinct from per-step errors). Populated by
	 * `workflowEngine.resetWorkflow` on a partial-failure reset to name the
	 * targets that could not be cleaned up (FR-009); cleared on successful
	 * reset. Other workflow paths leave this null.
	 */
	error: { message: string } | null;
	createdAt: string;
	updatedAt: string;
}

// Serializable workflow state for WebSocket messages (strips internal fields from workflow and steps)
export type WorkflowState = Omit<Workflow, "steps" | "feedbackPreRunHead"> & {
	steps: Omit<PipelineStep, "sessionId" | "prompt" | "pid">[];
};

// ── Artifact types ───────────────────────────────────────

export interface ArtifactDescriptor {
	id: string;
	step: PipelineStepName;
	displayLabel: string;
	affordanceLabel: string;
	relPath: string;
	sizeBytes: number;
	lastModified: string;
	exists: true;
	runOrdinal: number | null;
}

export interface ArtifactListResponse {
	workflowId: string;
	branch: string;
	items: ArtifactDescriptor[];
}

// ── Alert types ──────────────────────────────────────────

export type AlertType =
	| "question-asked"
	| "pr-opened-manual"
	| "workflow-finished"
	| "epic-finished"
	| "error";

export interface Alert {
	/** Stable identifier, e.g. `alert_<ulid>`. Generated server-side at emit time. */
	id: string;
	/** Category of event. Drives dedup key and (client-side) icon/label choice. */
	type: AlertType;
	/** Short human-readable title shown in the toast and list row. */
	title: string;
	/** One-line description; may embed the error message or question summary. */
	description: string;
	/** Originating workflow id, or null for epic-finished alerts. */
	workflowId: string | null;
	/** Originating epic id when the alert stems from an epic or an epic-owned workflow. */
	epicId: string | null;
	/** Client-side route target (e.g. `/workflow/<id>` or `/epic/<id>`). */
	targetRoute: string;
	/** Epoch ms at server-side emission time. Used for sort order and eviction. */
	createdAt: number;
}

// Server → Client messages
export type ServerMessage =
	| { type: "workflow:state"; workflow: WorkflowState | null }
	| { type: "workflow:list"; workflows: WorkflowState[] }
	| { type: "workflow:created"; workflow: WorkflowState }
	| { type: "workflow:output"; workflowId: string; text: string }
	| { type: "workflow:tools"; workflowId: string; tools: ToolUsage[] }
	| { type: "workflow:question"; workflowId: string; question: Question }
	| {
			type: "workflow:step-change";
			workflowId: string;
			previousStep: PipelineStepName | null;
			currentStep: PipelineStepName;
			currentStepIndex: number;
			reviewIteration: number;
	  }
	| { type: "epic:list"; epics: PersistedEpic[] }
	| { type: "epic:created"; epicId: string; description: string }
	| { type: "epic:output"; epicId: string; text: string }
	| { type: "epic:tools"; epicId: string; tools: ToolUsage[] }
	| { type: "epic:summary"; epicId: string; summary: string }
	| {
			type: "epic:result";
			epicId: string;
			title: string;
			specCount: number;
			workflowIds: string[];
			summary: string | null;
	  }
	| { type: "epic:infeasible"; epicId: string; title: string; infeasibleNotes: string }
	| { type: "epic:error"; epicId: string; message: string }
	| {
			type: "epic:dependency-update";
			workflowId: string;
			epicDependencyStatus: EpicDependencyStatus;
			blockingWorkflows: string[];
	  }
	| { type: "config:state"; config: AppConfig; warnings?: ConfigWarning[] }
	| {
			type: "default-model:info";
			modelInfo: { modelId: string; displayName: string } | null;
	  }
	| { type: "config:error"; errors: ConfigValidationError[] }
	| { type: "purge:progress"; step: string; current: number; total: number }
	| { type: "purge:complete"; warnings: string[] }
	| { type: "purge:error"; message: string; warnings: string[] }
	| {
			type: "repo:clone-start";
			submissionId: string;
			owner: string;
			repo: string;
			reused: boolean;
	  }
	| {
			type: "repo:clone-progress";
			submissionId: string;
			owner: string;
			repo: string;
			step: "resolving" | "cloning" | "fetching" | "ready";
			message?: string;
	  }
	| {
			type: "repo:clone-complete";
			submissionId: string;
			owner: string;
			repo: string;
			path: string;
	  }
	| {
			type: "repo:clone-error";
			submissionId: string;
			owner: string;
			repo: string;
			code:
				| "non-github-url"
				| "clone-failed"
				| "auth-required"
				| "not-found"
				| "network"
				| "unknown";
			message: string;
	  }
	| { type: "log"; text: string; workflowId?: string }
	| { type: "alert:list"; alerts: Alert[] }
	| { type: "alert:created"; alert: Alert }
	| { type: "alert:dismissed"; alertIds: string[] }
	| {
			type: "error";
			message: string;
			requestType?: "workflow:retry-workflow";
			code?: "invalid_state" | "not_found" | "persist_failed";
	  };

// Individual tool usage from CLI stream event
export interface ToolUsage {
	name: string;
	input?: Record<string, unknown>;
}

// Output entry union for client-side output log (text lines + tool icon data)
export type OutputEntry =
	| { kind: "text"; text: string; type?: "normal" | "error" | "system" }
	| { kind: "tools"; tools: ToolUsage[] };

// Client-side per-workflow state (not persisted, not sent over WebSocket)
export interface WorkflowClientState {
	state: WorkflowState;
	outputLines: OutputEntry[];
}

// Client-side epic analysis state
export type EpicStatus = "analyzing" | "completed" | "error" | "infeasible";

export interface PersistedEpic {
	epicId: string;
	description: string;
	status: EpicStatus;
	title: string | null;
	workflowIds: string[];
	startedAt: string;
	completedAt: string | null;
	errorMessage: string | null;
	infeasibleNotes: string | null;
	analysisSummary: string | null;
}

export interface EpicClientState extends PersistedEpic {
	outputLines: OutputEntry[];
}

// Pipeline orchestrator callbacks
export interface PipelineCallbacks {
	onStepChange: (
		workflowId: string,
		previousStep: PipelineStepName | null,
		currentStep: PipelineStepName,
		currentStepIndex: number,
		reviewIteration: number,
	) => void;
	onOutput: (workflowId: string, text: string) => void;
	onTools: (workflowId: string, tools: ToolUsage[]) => void;
	onComplete: (workflowId: string) => void;
	onError: (workflowId: string, error: string) => void;
	onStateChange: (workflowId: string) => void;
	onEpicDependencyUpdate?: (
		dependentWorkflowId: string,
		status: EpicDependencyStatus,
		blockingWorkflows: string[],
	) => void;
	/**
	 * Request emission of an alert. Server wires this to
	 * `alertQueue.emit` + broadcast. Dedup/cap/persistence are the queue's job.
	 */
	onAlertEmit?: (input: Omit<Alert, "id" | "createdAt">) => void;
	/** Bulk-dismiss alerts matching a filter (used for auto-clearing question alerts). */
	onAlertDismissWhere?: (filter: { type: AlertType; workflowId?: string; epicId?: string }) => void;
}

// ── State change types ──────────────────────────────────

export type StateChangeScope =
	| { entity: "workflow"; id: string }
	| { entity: "epic"; id: string }
	| { entity: "config"; key?: string }
	| { entity: "global" }
	| { entity: "output"; id: string }
	| { entity: "none" };

export type StateChangeAction = "added" | "updated" | "removed" | "cleared" | "appended";

export interface StateChange {
	scope: StateChangeScope;
	action: StateChangeAction;
}

export type StateChangeListener = (change: StateChange, msg: ServerMessage) => void;

// Client → Server messages
export type ClientMessage =
	| {
			type: "workflow:start";
			specification: string;
			targetRepository?: string;
			submissionId?: string;
			workflowKind?: WorkflowKind;
	  }
	| { type: "workflow:answer"; workflowId: string; questionId: string; answer: string }
	| { type: "workflow:skip"; workflowId: string; questionId: string }
	| { type: "workflow:pause"; workflowId: string }
	| { type: "workflow:resume"; workflowId: string }
	| { type: "workflow:abort"; workflowId: string }
	| { type: "workflow:retry"; workflowId: string }
	| { type: "workflow:retry-workflow"; workflowId: string }
	| {
			type: "epic:start";
			description: string;
			targetRepository?: string;
			autoStart: boolean;
			submissionId?: string;
	  }
	| { type: "epic:abort" }
	| { type: "workflow:start-existing"; workflowId: string }
	| { type: "workflow:force-start"; workflowId: string }
	| { type: "workflow:feedback"; workflowId: string; text: string }
	| { type: "config:get" }
	| { type: "config:save"; config: DeepPartial<AppConfig> }
	| { type: "config:reset"; key?: string }
	| { type: "alert:list" }
	| { type: "alert:dismiss"; alertId: string }
	| { type: "purge:all" };
