// ── Config types ──────────────────────────────────────────

export interface ModelConfig {
	questionDetection: string;
	reviewClassification: string;
	activitySummarization: string;
	specSummarization: string;
}

export interface PromptConfig {
	questionDetection: string;
	reviewClassification: string;
	activitySummarization: string;
	specSummarization: string;
	mergeConflictResolution: string;
	ciFixInstruction: string;
}

export interface LimitConfig {
	reviewCycleMaxIterations: number;
	ciFixMaxAttempts: number;
	mergeMaxAttempts: number;
}

export interface TimingConfig {
	ciGlobalTimeoutMs: number;
	ciPollIntervalMs: number;
	questionDetectionCooldownMs: number;
	activitySummaryIntervalMs: number;
	rateLimitBackoffMs: number;
	maxCiLogLength: number;
	maxClientOutputLines: number;
}

export interface AppConfig {
	models: ModelConfig;
	prompts: PromptConfig;
	limits: LimitConfig;
	timing: TimingConfig;
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

// Workflow status enum
export type WorkflowStatus =
	| "idle"
	| "running"
	| "waiting_for_input"
	| "completed"
	| "cancelled"
	| "error";

// Valid state transitions
export const VALID_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
	idle: ["running"],
	running: ["waiting_for_input", "completed", "error", "cancelled"],
	waiting_for_input: ["running", "cancelled"],
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

export const REVIEW_CYCLE_MAX_ITERATIONS = 16;

// Workflow entity (extended with pipeline fields)
export interface Workflow {
	id: string;
	specification: string;
	status: WorkflowStatus;
	targetRepository: string | null;
	worktreePath: string | null;
	worktreeBranch: string;
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
	| { type: "workflow:tools"; workflowId: string; tools: Record<string, number> }
	| { type: "workflow:question"; workflowId: string; question: Question }
	| {
			type: "workflow:step-change";
			workflowId: string;
			previousStep: PipelineStepName | null;
			currentStep: PipelineStepName;
			currentStepIndex: number;
			reviewIteration: number;
	  }
	| { type: "config:state"; config: AppConfig; warnings?: ConfigWarning[] }
	| { type: "config:error"; errors: ConfigValidationError[] }
	| { type: "error"; message: string };

// Output entry union for client-side output log (text lines + tool icon data)
export type OutputEntry =
	| { kind: "text"; text: string; type?: "normal" | "error" | "system" }
	| { kind: "tools"; tools: Record<string, number> };

// Client-side per-workflow state (not persisted, not sent over WebSocket)
export interface WorkflowClientState {
	state: WorkflowState;
	outputLines: OutputEntry[];
	isExpanded: boolean;
}

// Client → Server messages
export type ClientMessage =
	| { type: "workflow:start"; specification: string; targetRepository?: string }
	| { type: "workflow:answer"; workflowId: string; questionId: string; answer: string }
	| { type: "workflow:skip"; workflowId: string; questionId: string }
	| { type: "workflow:cancel"; workflowId: string }
	| { type: "workflow:retry"; workflowId: string }
	| { type: "config:get" }
	| { type: "config:save"; config: Partial<AppConfig> }
	| { type: "config:reset"; key?: string };
