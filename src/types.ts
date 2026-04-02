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
	confidence: "certain" | "uncertain";
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
	| "commit-push-pr";

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
];

export const REVIEW_CYCLE_MAX_ITERATIONS = 16;

// Workflow entity (extended with pipeline fields)
export interface Workflow {
	id: string;
	specification: string;
	status: WorkflowStatus;
	worktreePath: string | null;
	worktreeBranch: string;
	summary: string;
	pendingQuestion: Question | null;
	lastOutput: string;
	steps: PipelineStep[];
	currentStepIndex: number;
	reviewCycle: ReviewCycle;
	createdAt: string;
	updatedAt: string;
}

// Serializable workflow state for WebSocket messages (strips internal fields from workflow and steps)
export type WorkflowState = Omit<Workflow, "steps"> & {
	steps: Omit<PipelineStep, "sessionId" | "prompt">[];
};

// Server → Client messages
export type ServerMessage =
	| { type: "workflow:state"; workflow: WorkflowState | null }
	| { type: "workflow:output"; workflowId: string; text: string }
	| { type: "workflow:question"; workflowId: string; question: Question }
	| { type: "workflow:summary"; workflowId: string; summary: string }
	| {
			type: "workflow:step-change";
			workflowId: string;
			previousStep: PipelineStepName | null;
			currentStep: PipelineStepName;
			currentStepIndex: number;
			reviewIteration: number;
	  }
	| { type: "error"; message: string };

// Client → Server messages
export type ClientMessage =
	| { type: "workflow:start"; specification: string }
	| { type: "workflow:answer"; workflowId: string; questionId: string; answer: string }
	| { type: "workflow:skip"; workflowId: string; questionId: string }
	| { type: "workflow:cancel"; workflowId: string }
	| { type: "workflow:retry"; workflowId: string };
