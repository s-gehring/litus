// Domain type re-exports — wire-relevant types live in `@litus/protocol`.
// Server-internal types (PipelineCallbacks) and helper functions
// (`isFeedbackEligible`) stay here.

import type { Alert, EpicDependencyStatus, AspectState, ToolUsage, PersistedEpic, Workflow } from "@litus/protocol";
import type { PipelineStepName } from "@litus/protocol";

export type {
	ActiveAIInvocation,
	AIInvocationRole,
	Alert,
	AlertType,
	AppConfig,
	ArtifactDescriptor,
	ArtifactListResponse,
	AspectManifest,
	AspectManifestEntry,
	AspectState,
	AspectStatus,
	AuditEvent,
	AuditEventType,
	CiCheckResult,
	CiCycle,
	CiFailureLog,
	ClientMessage,
	DependencyGraph,
	EffortLevel,
	EpicAggregatedState,
	EpicAggregatedStatus,
	EpicAnalysisResult,
	EpicClientState,
	EpicDependencyStatus,
	EpicFeedbackEntry,
	EpicSpecEntry,
	EpicStatus,
	FeedbackEntry,
	FeedbackKind,
	FeedbackOutcome,
	FeedbackOutcomeValue,
	FeedbackOutcomeWarning,
	MergeCycle,
	MergeResult,
	OutputEntry,
	PersistedEpic,
	PipelineStep,
	PipelineStepName,
	PipelineStepRun,
	PipelineStepStatus,
	Question,
	ReviewCycle,
	ReviewSeverity,
	ServerMessage,
	SetupCheckResult,
	SetupResult,
	StateChange,
	StateChangeAction,
	StateChangeListener,
	StateChangeScope,
	SyncResult,
	SynthesizedAnswer,
	ToolUsage,
	Workflow,
	WorkflowClientState,
	WorkflowIndexEntry,
	WorkflowKind,
	WorkflowResetAuditEvent,
	WorkflowState,
	WorkflowStatus,
} from "@litus/protocol";

export {
	ASK_QUESTION_FEEDBACK_MAX_LENGTH,
	ASK_QUESTION_MAX_LENGTH,
	DELTA_FLUSH_TIMEOUT_MS,
	EPIC_FEEDBACK_MAX_LENGTH,
	MAX_LLM_INPUT_LENGTH,
	RESUME_WITH_FEEDBACK_MAX_LENGTH,
} from "@litus/protocol";

export function isFeedbackEligible(
	epic: PersistedEpic,
	childWorkflows: Pick<Workflow, "hasEverStarted">[],
): boolean {
	if (epic.status === "analyzing") return false;
	if (childWorkflows.some((w) => w.hasEverStarted)) return false;
	return true;
}

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
	onAspectOutput?: (workflowId: string, aspectId: string, text: string) => void;
	onAspectTools?: (workflowId: string, aspectId: string, tools: ToolUsage[]) => void;
	onAspectState?: (workflowId: string, aspectId: string, state: AspectState) => void;
	onEpicDependencyUpdate?: (
		dependentWorkflowId: string,
		status: EpicDependencyStatus,
		blockingWorkflows: string[],
	) => void;
	onAlertEmit?: (input: Omit<Alert, "id" | "createdAt" | "seen">) => void;
	onAlertMarkSeenWhere?: (predicate: (alert: Alert) => boolean) => void;
}
