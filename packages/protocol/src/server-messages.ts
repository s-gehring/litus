// Server → Client messages. TS-only union for now; Zod schemas land in US2.

import type {
	Alert,
	AppConfig,
	AspectState,
	ConfigValidationError,
	ConfigWarning,
	EpicDependencyStatus,
	EpicFeedbackEntry,
	PersistedEpic,
	PipelineStepName,
	Question,
	ToolUsage,
	WorkflowState,
	WorkflowStatus,
} from "./shared-types";

export type ServerMessage =
	| { type: "workflow:state"; workflow: WorkflowState | null }
	| { type: "workflow:removed"; workflowId: string }
	| { type: "workflow:list"; workflows: WorkflowState[] }
	| { type: "workflow:created"; workflow: WorkflowState }
	| { type: "workflow:output"; workflowId: string; text: string }
	| { type: "workflow:tools"; workflowId: string; tools: ToolUsage[] }
	| { type: "workflow:aspect:output"; workflowId: string; aspectId: string; text: string }
	| { type: "workflow:aspect:tools"; workflowId: string; aspectId: string; tools: ToolUsage[] }
	| {
			type: "workflow:aspect:state";
			workflowId: string;
			aspectId: string;
			state: AspectState;
	  }
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
	| { type: "epic:feedback:accepted"; epicId: string; entry: EpicFeedbackEntry }
	| {
			type: "epic:feedback:rejected";
			epicId: string;
			reasonCode: "spec_started" | "in_flight" | "validation";
			reason: string;
	  }
	| {
			type: "epic:feedback:history";
			epicId: string;
			entries: EpicFeedbackEntry[];
			sessionContextLost: boolean;
	  }
	| {
			type: "epic:dependency-update";
			workflowId: string;
			epicDependencyStatus: EpicDependencyStatus;
			blockingWorkflows: string[];
	  }
	| {
			type: "epic:start-first-level:result";
			epicId: string;
			started: string[];
			skipped: string[];
			failed: { workflowId: string; message: string }[];
	  }
	| {
			type: "config:state";
			config: AppConfig;
			warnings?: ConfigWarning[];
	  }
	| { type: "telegram:test-result"; ok: true }
	| {
			type: "telegram:test-result";
			ok: false;
			errorCode: number | null;
			reason: string;
	  }
	| {
			type: "telegram:status";
			unacknowledgedCount: number;
			lastFailureReason: string | null;
			lastFailureAt: number | null;
	  }
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
	| { type: "console:output"; text: string }
	| { type: "alert:list"; alerts: Alert[] }
	| { type: "alert:created"; alert: Alert }
	| { type: "alert:dismissed"; alertIds: string[] }
	| { type: "alert:seen"; alertIds: string[] }
	| {
			type: "workflow:archive-denied";
			workflowId: string | null;
			epicId: string | null;
			reason:
				| "not-archivable-state"
				| "child-spec-independent-archive"
				| "not-found"
				| "already-archived"
				| "already-active"
				| "persist-failed";
			message: string;
	  }
	| { type: "auto-archive:state"; active: boolean }
	| {
			type: "workflow:feedback:ok";
			workflowId: string;
			kind: "resume-with-feedback";
			feedbackEntryId: string;
			warning?: "prompt-injection-failed";
			workflowStatusAfter?: "error";
	  }
	| {
			type: "workflow:feedback:rejected";
			workflowId: string;
			reason: "workflow-not-paused" | "step-not-resumable" | "text-length" | "workflow-not-found";
			currentState: { status: WorkflowStatus; currentStepIndex: number };
	  }
	| {
			type: "error";
			message: string;
			requestType?: "workflow:retry-workflow";
			code?: "invalid_state" | "not_found" | "persist_failed";
	  };
