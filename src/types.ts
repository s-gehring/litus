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
	error: [],
};

// Question entity
export interface Question {
	id: string;
	content: string;
	confidence: "certain" | "uncertain";
	detectedAt: string;
}

// Workflow entity
export interface Workflow {
	id: string;
	specification: string;
	status: WorkflowStatus;
	sessionId: string | null;
	worktreePath: string | null;
	worktreeBranch: string;
	summary: string;
	pendingQuestion: Question | null;
	lastOutput: string;
	createdAt: string;
	updatedAt: string;
}

// Serializable workflow state for WebSocket messages (all Workflow fields except sessionId)
export type WorkflowState = Omit<Workflow, "sessionId">;

// Server → Client messages
export type ServerMessage =
	| { type: "workflow:state"; workflow: WorkflowState | null }
	| { type: "workflow:output"; workflowId: string; text: string }
	| { type: "workflow:question"; workflowId: string; question: Question }
	| { type: "workflow:summary"; workflowId: string; summary: string }
	| { type: "error"; message: string };

// Client → Server messages
export type ClientMessage =
	| { type: "workflow:start"; specification: string }
	| { type: "workflow:answer"; workflowId: string; questionId: string; answer: string }
	| { type: "workflow:skip"; workflowId: string; questionId: string }
	| { type: "workflow:cancel"; workflowId: string };
