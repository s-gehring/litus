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

export type EffortLevel = "low" | "medium" | "high" | "max";

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

export interface AppConfig {
	models: ModelConfig;
	efforts: EffortConfig;
	prompts: PromptConfig;
	limits: LimitConfig;
	timing: TimingConfig;
	autoMode: boolean;
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
export type AuditEventType = "pipeline_start" | "pipeline_end" | "query" | "answer" | "commit";

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
	| "cancelled"
	| "error";

// Valid state transitions
export const VALID_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
	idle: ["running", "waiting_for_dependencies"],
	running: ["waiting_for_input", "completed", "error", "paused"],
	waiting_for_input: ["running", "cancelled"],
	waiting_for_dependencies: ["running", "cancelled"],
	paused: ["running", "cancelled", "error"],
	completed: [],
	cancelled: [],
	error: ["running"],
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
	| "commit-push-pr"
	| "monitor-ci"
	| "fix-ci"
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

// Pipeline step entity
export interface PipelineStep {
	name: PipelineStepName;
	displayName: string;
	status: PipelineStepStatus;
	prompt: string;
	sessionId: string | null;
	output: string;
	error: string | null;
	startedAt: string | null;
	completedAt: string | null;
	pid: number | null;
}

// Lightweight metadata for fast workflow listing without loading full state
export interface WorkflowIndexEntry {
	id: string;
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

// Step definitions: name → display name and prompt template
export const PIPELINE_STEP_DEFINITIONS: ReadonlyArray<{
	name: PipelineStepName;
	displayName: string;
	prompt: string;
}> = [
	{ name: "setup", displayName: "Setup", prompt: "" },
	{ name: "specify", displayName: "Specifying", prompt: "/speckit.specify" },
	{ name: "clarify", displayName: "Clarifying", prompt: "/speckit.clarify" },
	{ name: "plan", displayName: "Planning", prompt: "/speckit.plan" },
	{ name: "tasks", displayName: "Generating Tasks", prompt: "/speckit.tasks" },
	{ name: "implement", displayName: "Implementing", prompt: "/speckit.implement" },
	{ name: "review", displayName: "Reviewing", prompt: "/speckit.review" },
	{ name: "implement-review", displayName: "Fixing Review", prompt: "/speckit.implementreview" },
	{ name: "commit-push-pr", displayName: "Creating PR", prompt: "/commit-commands:commit-push-pr" },
	{ name: "monitor-ci", displayName: "Monitoring CI", prompt: "" },
	{ name: "fix-ci", displayName: "Fixing CI", prompt: "" },
	{ name: "merge-pr", displayName: "Merging PR", prompt: "" },
	{ name: "sync-repo", displayName: "Syncing Repository", prompt: "" },
];

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
	COMMIT_PUSH_PR: "commit-push-pr",
	MONITOR_CI: "monitor-ci",
	FIX_CI: "fix-ci",
	MERGE_PR: "merge-pr",
	SYNC_REPO: "sync-repo",
} as const satisfies Record<string, PipelineStepName>;

// Delta buffer flush timeout used across CLI stream consumers
export const DELTA_FLUSH_TIMEOUT_MS = 50;

// Workflow entity (extended with pipeline fields)
export interface Workflow {
	id: string;
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
	createdAt: string;
	updatedAt: string;
}

// Serializable workflow state for WebSocket messages (strips internal fields from workflow and steps)
export type WorkflowState = Omit<Workflow, "steps"> & {
	steps: Omit<PipelineStep, "sessionId" | "prompt" | "pid">[];
};

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
	| { type: "config:error"; errors: ConfigValidationError[] }
	| { type: "purge:progress"; step: string; current: number; total: number }
	| { type: "purge:complete"; warnings: string[] }
	| { type: "log"; text: string }
	| { type: "error"; message: string };

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
	| { type: "workflow:start"; specification: string; targetRepository?: string }
	| { type: "workflow:answer"; workflowId: string; questionId: string; answer: string }
	| { type: "workflow:skip"; workflowId: string; questionId: string }
	| { type: "workflow:pause"; workflowId: string }
	| { type: "workflow:resume"; workflowId: string }
	| { type: "workflow:abort"; workflowId: string }
	| { type: "workflow:retry"; workflowId: string }
	| { type: "epic:start"; description: string; targetRepository?: string; autoStart: boolean }
	| { type: "epic:cancel" }
	| { type: "workflow:start-existing"; workflowId: string }
	| { type: "workflow:force-start"; workflowId: string }
	| { type: "config:get" }
	| { type: "config:save"; config: Partial<AppConfig> }
	| { type: "config:reset"; key?: string }
	| { type: "purge:all" };
