// ── Shared dependent types ────────────────────────────────
//
// Type declarations referenced by `ServerMessage` / `ClientMessage` variants.
// These types travel with the wire contract because the server↔client
// frames embed them. Runtime helpers (validators, state-machine tables,
// step definitions) intentionally stay server-side; this file is types
// only so the package remains frontend-agnostic.

// ── Config (from config-types.ts) ──────────────────────────

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface ModelConfig {
	questionDetection: string;
	reviewClassification: string;
	activitySummarization: string;
	specSummarization: string;
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
	artifacts: string;
	commitPushPr: string;
	askQuestionDecomposition: string;
	askQuestionResearch: string;
	askQuestionSynthesis: string;
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface EffortConfig {
	questionDetection: EffortLevel;
	reviewClassification: EffortLevel;
	activitySummarization: EffortLevel;
	specSummarization: EffortLevel;
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
	artifacts: EffortLevel;
	commitPushPr: EffortLevel;
	askQuestionDecomposition: EffortLevel;
	askQuestionResearch: EffortLevel;
	askQuestionSynthesis: EffortLevel;
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
	askQuestionDecomposition: string;
	askQuestionResearch: string;
	askQuestionSynthesis: string;
}

export interface LimitConfig {
	reviewCycleMaxIterations: number;
	ciFixMaxAttempts: number;
	mergeMaxAttempts: number;
	maxJsonRetries: number;
	artifactsPerFileMaxBytes: number;
	artifactsPerStepMaxBytes: number;
	askQuestionMaxAspects: number;
	askQuestionConcurrentAspects: number;
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
	artifactsTimeoutMs: number;
}

export type AutoMode = "manual" | "normal" | "full-auto";

export interface TelegramSettings {
	botToken: string;
	chatId: string;
	active: boolean;
}

export interface AppConfig {
	models: ModelConfig;
	efforts: EffortConfig;
	prompts: PromptConfig;
	limits: LimitConfig;
	timing: TimingConfig;
	autoMode: AutoMode;
	telegram: TelegramSettings;
}

export interface PromptVariableInfo {
	name: string;
	description: string;
}

export type NumericSettingInputKind = "scalar" | "size" | "duration";

export interface NumericSettingMeta {
	key: string;
	label: string;
	description: string;
	min: number;
	defaultValue: number;
	unit?: string;
	inputKind?: NumericSettingInputKind;
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

export interface AuditConfig {
	auditDir?: string;
}

// ── Pipeline taxonomy (from pipeline-steps.ts) ─────────────

export type WorkflowStatus =
	| "idle"
	| "running"
	| "waiting_for_input"
	| "waiting_for_dependencies"
	| "paused"
	| "completed"
	| "aborted"
	| "error";

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
	| "sync-repo"
	| "decompose"
	| "research-aspect"
	| "synthesize"
	| "answer"
	| "finalize";

export type PipelineStepStatus =
	| "pending"
	| "running"
	| "waiting_for_input"
	| "paused"
	| "completed"
	| "error";

export type ArtifactsStepOutcome = "with-files" | "empty";

export interface PipelineStepRun {
	runNumber: number;
	status: "completed" | "error" | "paused";
	output: string;
	outputLog: OutputEntry[];
	error: string | null;
	startedAt: string;
	completedAt: string | null;
}

export interface PipelineStep {
	name: PipelineStepName;
	displayName: string;
	status: PipelineStepStatus;
	prompt: string;
	sessionId: string | null;
	output: string;
	outputLog: OutputEntry[];
	error: string | null;
	startedAt: string | null;
	completedAt: string | null;
	pid: number | null;
	history: PipelineStepRun[];
	outcome?: ArtifactsStepOutcome | null;
}

// ── Workflow & domain types (from types.ts) ────────────────

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

export interface Question {
	id: string;
	content: string;
	detectedAt: string;
}

export type WorkflowKind = "spec" | "quick-fix" | "ask-question";

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
	output: string;
	outputLog: OutputEntry[];
}

export interface SynthesizedAnswer {
	markdown: string;
	updatedAt: string;
	sourceFileName: string;
}

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

export interface CiCheckResult {
	name: string;
	state: string;
	bucket: string;
	link: string;
}

export interface CiFailureLog {
	checkName: string;
	runId: string;
	logs: string;
}

export interface CiCycle {
	attempt: number;
	maxAttempts: number;
	monitorStartedAt: string | null;
	globalTimeoutMs: number;
	lastCheckResults: CiCheckResult[];
	pollCount?: number;
	failureLogs: CiFailureLog[];
	userFixGuidance?: string | null;
}

export interface MergeCycle {
	attempt: number;
	maxAttempts: number;
}

export interface MergeResult {
	merged: boolean;
	alreadyMerged: boolean;
	conflict: boolean;
	error: string | null;
}

export interface SyncResult {
	pulled: boolean;
	skipped: boolean;
	worktreeRemoved: boolean;
	warning: string | null;
}

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

export type ReviewSeverity = "critical" | "major" | "minor" | "trivial" | "nit";

export interface ReviewCycle {
	iteration: number;
	maxIterations: number;
	lastSeverity: ReviewSeverity | null;
}

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

export type AIInvocationRole = "main" | "helper";

export interface ActiveAIInvocation {
	model: string;
	effort: EffortLevel | null;
	stepName: PipelineStepName;
	startedAt: string;
	role: "main";
}

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
	feedbackPreRunHead: string | null;
	activeInvocation: ActiveAIInvocation | null;
	managedRepo: { owner: string; repo: string } | null;
	error: { message: string } | null;
	hasEverStarted: boolean;
	createdAt: string;
	updatedAt: string;
	archived: boolean;
	archivedAt: string | null;
	autoArchiveExempt?: boolean;
	aspectManifest: AspectManifest | null;
	aspects: AspectState[] | null;
	synthesizedAnswer: SynthesizedAnswer | null;
}

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
	description?: string;
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
	id: string;
	type: AlertType;
	title: string;
	description: string;
	workflowId: string | null;
	epicId: string | null;
	targetRoute: string;
	createdAt: number;
	seen: boolean;
}

// ── Tool/output types ────────────────────────────────────

export interface ToolUsage {
	name: string;
	input?: Record<string, unknown>;
}

export type OutputEntry =
	| { kind: "text"; text: string; type?: "normal" | "error" | "system" }
	| { kind: "tools"; tools: ToolUsage[] };

export interface WorkflowClientState {
	state: WorkflowState;
	outputLines: OutputEntry[];
}

// ── Epic persisted/client types ──────────────────────────

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
	decompositionSessionId: string | null;
	feedbackHistory: EpicFeedbackEntry[];
	sessionContextLost: boolean;
	attemptCount: number;
	archived: boolean;
	archivedAt: string | null;
	autoArchiveExempt?: boolean;
}

export interface EpicFeedbackEntry {
	id: string;
	text: string;
	submittedAt: string;
	attemptSessionId: string | null;
	contextLostOnThisAttempt: boolean;
	outcome: "completed" | "infeasible" | "error" | null;
}

export interface EpicClientState extends PersistedEpic {
	outputLines: OutputEntry[];
}

// ── Audit event types ────────────────────────────────────

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

// ── Shared length caps ───────────────────────────────────
//
// Used by both client and server-side validators for parity.

export const MAX_LLM_INPUT_LENGTH = 300_000;
export const ASK_QUESTION_MAX_LENGTH = MAX_LLM_INPUT_LENGTH;
export const EPIC_FEEDBACK_MAX_LENGTH = MAX_LLM_INPUT_LENGTH;
export const RESUME_WITH_FEEDBACK_MAX_LENGTH = MAX_LLM_INPUT_LENGTH;
export const ASK_QUESTION_FEEDBACK_MAX_LENGTH = MAX_LLM_INPUT_LENGTH;
