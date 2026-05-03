import type { EffortLevel } from "./config-types";
import type { PipelineStep, PipelineStepName, WorkflowStatus } from "./pipeline-steps";

// Re-exports for backward compatibility after the types.ts split.
export type { AppConfig, EffortLevel } from "./config-types";
export {
	type ClientMessage,
	DELTA_FLUSH_TIMEOUT_MS,
	type ServerMessage,
	type StateChange,
	type StateChangeAction,
	type StateChangeListener,
	type StateChangeScope,
} from "./protocol";

// ── Audit event types ─────────────────────────────────────

export type AuditEventType =
	| "pipeline_start"
	| "pipeline_end"
	| "query"
	| "answer"
	| "commit"
	| "workflow.reset"
	| "workflow.archive"
	| "workflow.unarchive"
	| "epic.archive"
	| "epic.unarchive"
	| "artifacts.step.start"
	| "artifacts.step.end"
	| "feedback_submitted"
	| "feedback_submitted_resume"
	| "feedback_submitted_ask_question"
	| "decomposition_resumed";

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

// Question entity
export interface Question {
	id: string;
	content: string;
	detectedAt: string;
}

// Workflow kind: "spec" is the existing Speckit pipeline; "quick-fix" is the
// direct-implementation pipeline driven by the user's fix description;
// "ask-question" is the research/synthesis pipeline that produces a
// markdown answer to a free-form user question.
export type WorkflowKind = "spec" | "quick-fix" | "ask-question";

// ── Ask-question types ───────────────────────────────────

export interface AspectManifestEntry {
	id: string;
	title: string;
	researchPrompt: string;
	fileName: string;
}

export interface AspectManifest {
	version: 1;
	aspects: AspectManifestEntry[];
}

export type AspectStatus = "pending" | "in_progress" | "completed" | "errored";

export interface AspectState {
	id: string;
	fileName: string;
	status: AspectStatus;
	sessionId: string | null;
	startedAt: string | null;
	completedAt: string | null;
	errorMessage: string | null;
	/**
	 * Live + persisted text mirror of `outputLog`'s text entries. Capped to
	 * `MAX_ASPECT_OUTPUT_CHARS` via `enforceAspectOutputCap`. Reset to "" on
	 * dispatch (and on retry — clarification Q2: panel wipes on retry).
	 */
	output: string;
	/**
	 * Structured per-aspect log entries (text + tool icons interleaved) used
	 * by the per-aspect grid panel during the research-aspect step. Same
	 * `OutputEntry` union as `PipelineStep.outputLog`. Reset to [] on dispatch
	 * and on retry.
	 */
	outputLog: OutputEntry[];
}

export interface SynthesizedAnswer {
	markdown: string;
	updatedAt: string;
	sourceFileName: string;
}

// Server-side guardrail on the user's submitted question text. Trimmed
// length must be ≤ this value before workflow creation; the client
// repeats the same check pre-send (defense-in-depth).
export const ASK_QUESTION_MAX_LENGTH = 300_000;

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
	archived: boolean;
	archivedAt: string | null;
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
	/**
	 * Free-form text supplied by the user when answering the "all CI checks
	 * cancelled" question with anything other than "retry" / "abort". Passed
	 * to the Fixing CI agent on the next fix attempt and cleared afterwards.
	 */
	userFixGuidance?: string | null;
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

// Maximum trimmed feedback length accepted by the epic-decomposition feedback
// endpoint (FR-005). Shared between the client-side counter/panel and the
// server-side validation so the two cannot drift.
export const EPIC_FEEDBACK_MAX_LENGTH = 10_000;

// Maximum trimmed text length for the resume-with-feedback flow (FR-014).
// Shared between the orchestrator's authoritative validation and the
// handler-level early-rejection so the two cannot drift.
export const RESUME_WITH_FEEDBACK_MAX_LENGTH = 10_000;

// Maximum trimmed feedback length for the ask-question iteration flow.
// Shared between the WS handler and the orchestrator's authoritative
// validation so the two cannot drift.
export const ASK_QUESTION_FEEDBACK_MAX_LENGTH = 100_000;

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

export type FeedbackKind =
	| "resume-with-feedback"
	| "merge-pr-iteration"
	| "fix-implement-retry"
	| "ask-question-iteration";

export interface FeedbackEntry {
	id: string;
	iteration: number;
	text: string;
	submittedAt: string;
	submittedAtStepName: PipelineStepName;
	outcome: FeedbackOutcome | null;
	kind?: FeedbackKind;
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
	/**
	 * Set true on the first transition out of `idle`/`waiting_for_dependencies`;
	 * never cleared (not even by resetWorkflow). Feedback eligibility uses this
	 * rather than the current `status`, because reset can land a workflow back
	 * in `idle`.
	 */
	hasEverStarted: boolean;
	createdAt: string;
	updatedAt: string;
	/** Pure visibility flag. Orthogonal to `status`. See 001-archive-workflows. */
	archived: boolean;
	/** ISO-8601 timestamp when `archived` flipped to true; null otherwise. */
	archivedAt: string | null;
	/**
	 * Set when a user manually unarchives this workflow. The auto-archive
	 * sweeper skips items with this flag so a deliberate unarchive isn't
	 * immediately undone on the next sweep.
	 */
	autoArchiveExempt?: boolean;
	/**
	 * Parsed aspect manifest produced by the `decompose` step on an ask-question
	 * workflow. Null until decompose succeeds; null for non-ask-question kinds.
	 * Preserved across feedback iterations and server restarts.
	 */
	aspectManifest: AspectManifest | null;
	/**
	 * Per-aspect runtime state, mirroring `aspectManifest.aspects` order. Null
	 * until decompose succeeds; null for non-ask-question kinds.
	 */
	aspects: AspectState[] | null;
	/**
	 * Most-recent synthesized answer text, mirrored from the worktree's answer
	 * file so the detail panel can render it after a server restart or after
	 * the worktree has been removed at finalize. Null until the first
	 * successful synthesize; null for non-ask-question kinds.
	 */
	synthesizedAnswer: SynthesizedAnswer | null;
}

// Serializable workflow state for WebSocket messages (strips internal fields from workflow and steps)
export type WorkflowState = Omit<Workflow, "steps" | "feedbackPreRunHead"> & {
	steps: (Omit<PipelineStep, "sessionId" | "prompt" | "pid"> & { hasResumableSession?: boolean })[];
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
	// Present only for `step === "artifacts"` entries: LLM-provided short
	// description from the manifest, shown next to the file name in the UI.
	description?: string;
	// Optional MIME hint; falls back to browser sniffing/extension when absent.
	contentType?: string;
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
	/**
	 * True once the user has been exposed to the alert in its source context.
	 * Excluded from the badge count; rendered as dimmed in the list. Auto-flips
	 * via question-answered / route-viewed / create-as-seen rules. `error` alerts
	 * never auto-flip — only explicit dismissal removes them.
	 */
	seen: boolean;
}

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
	/** Session ID of the most recent decomposition agent invocation for this epic. */
	decompositionSessionId: string | null;
	/** Chronological feedback round history (oldest first). */
	feedbackHistory: EpicFeedbackEntry[];
	/** True for one completion cycle after a fresh-fallback attempt. */
	sessionContextLost: boolean;
	/** Monotonic counter of attempts; 1 = initial, each accepted feedback increments. */
	attemptCount: number;
	archived: boolean;
	archivedAt: string | null;
	/**
	 * Set when a user manually unarchives this epic. The auto-archive sweeper
	 * skips items with this flag so a deliberate unarchive isn't immediately
	 * undone on the next sweep.
	 */
	autoArchiveExempt?: boolean;
}

export interface EpicFeedbackEntry {
	/** Stable identifier (uuid v4). */
	id: string;
	/** Trimmed submitted text, 1–10 000 chars. */
	text: string;
	/** ISO 8601 timestamp of server-side acceptance. */
	submittedAt: string;
	/** Session ID of the attempt this feedback initiated; null if fresh-fallback or not yet captured. */
	attemptSessionId: string | null;
	/** True iff this attempt fell back to a fresh decomposition. */
	contextLostOnThisAttempt: boolean;
	/** Terminal outcome of the attempt, or null while in-flight. */
	outcome: "completed" | "infeasible" | "error" | null;
}

export function isFeedbackEligible(
	epic: PersistedEpic,
	childWorkflows: Pick<Workflow, "hasEverStarted">[],
): boolean {
	if (epic.status === "analyzing") return false;
	if (childWorkflows.some((w) => w.hasEverStarted)) return false;
	return true;
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
	onAlertEmit?: (input: Omit<Alert, "id" | "createdAt" | "seen">) => void;
	/**
	 * Mark alerts matching the predicate as seen (FR-003: question-asked flips
	 * to seen when the workflow exits `waiting_for_input`). The server
	 * broadcaster filters `type === "error"` defensively.
	 */
	onAlertMarkSeenWhere?: (predicate: (alert: Alert) => boolean) => void;
}
