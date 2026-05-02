// ── Wire protocol ─────────────────────────────────────────
//
// Server↔Client messages, transport channel routing, and the in-process
// state-change observer types. Importable from both server and client
// without exposing server-internal domain shapes (notably `Workflow`).

import type { AppConfig, ConfigValidationError, ConfigWarning, DeepPartial } from "./config-types";
import type { PipelineStepName, WorkflowStatus } from "./pipeline-steps";
import type {
	Alert,
	EpicDependencyStatus,
	EpicFeedbackEntry,
	PersistedEpic,
	Question,
	ToolUsage,
	WorkflowKind,
	WorkflowState,
} from "./types";

// Coalescing window for `StateChange` deltas before they flush to clients.
// 50 ms trades a small added latency for meaningful message coalescing under
// burst (CLI stream events arriving in the same tick collapse into one frame).
// Lower values increase WebSocket chatter under load; higher values become
// perceptible to the UI.
export const DELTA_FLUSH_TIMEOUT_MS = 50;

/**
 * Routing target for a free-text server→client message.
 *
 * Closed discriminated union — adding a variant requires updating every
 * exhaustive `switch (channel.kind)` site.
 */
export type Channel =
	| { kind: "workflow"; workflowId: string }
	| { kind: "epic"; epicId: string }
	| { kind: "console" };

// Server → Client messages
export type ServerMessage =
	| { type: "workflow:state"; workflow: WorkflowState | null }
	| { type: "workflow:removed"; workflowId: string }
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
	| { type: "epic:feedback"; epicId: string; text: string }
	| { type: "epic:feedback:ack-context-lost"; epicId: string }
	| { type: "epic:start-first-level"; epicId: string }
	// Fan-out controls for the epic detail view: the server iterates the
	// epic's child workflows and dispatches the per-workflow control to each
	// non-terminal child. Best-effort: a child whose status doesn't admit the
	// control (e.g. abort on already-aborted) is silently skipped.
	| { type: "epic:pause-all"; epicId: string }
	| { type: "epic:resume-all"; epicId: string }
	| { type: "epic:abort-all"; epicId: string }
	| { type: "workflow:start-existing"; workflowId: string }
	| { type: "workflow:force-start"; workflowId: string }
	| { type: "workflow:feedback"; workflowId: string; text: string }
	| { type: "config:get" }
	| { type: "config:save"; config: DeepPartial<AppConfig> }
	| { type: "config:reset"; key?: string }
	| { type: "alert:list" }
	| { type: "alert:dismiss"; alertId: string }
	| { type: "alert:clear-all" }
	| { type: "alert:route-changed"; path: string }
	| { type: "workflow:archive"; workflowId: string }
	| { type: "workflow:unarchive"; workflowId: string }
	| { type: "epic:archive"; epicId: string }
	| { type: "epic:unarchive"; epicId: string }
	| { type: "auto-archive:stop" }
	| { type: "auto-archive:start" }
	| { type: "purge:all" }
	| { type: "client:warning"; source: string; message: string };

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
