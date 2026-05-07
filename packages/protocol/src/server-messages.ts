// Server → Client messages. Zod schemas + TS types via `z.infer<>`.
//
// Complex nested shared types (WorkflowState, PersistedEpic, AspectState,
// Question, ToolUsage, Alert, AppConfig, EpicFeedbackEntry,
// EpicDependencyStatus, ConfigValidationError, ConfigWarning, PipelineStepName,
// WorkflowStatus) are accepted via `z.custom<T>()` so the discriminated
// union over `type` is the load-bearing validation while preserving the
// nominal TS type for callers. The contract suite pins the structural
// shapes via fixtures; tightening to nested object schemas is a
// follow-up that landed under the same FR-016 surface.

import { z } from "zod";
import { errorFrameSchema } from "./error-frame";
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

const repoCloneStepSchema = z.enum(["resolving", "cloning", "fetching", "ready"]);
const repoCloneErrorCodeSchema = z.enum([
	"non-github-url",
	"clone-failed",
	"auth-required",
	"not-found",
	"network",
	"unknown",
]);
const archiveDeniedReasonSchema = z.enum([
	"not-archivable-state",
	"child-spec-independent-archive",
	"not-found",
	"already-archived",
	"already-active",
	"persist-failed",
]);
const workflowFeedbackRejectedReasonSchema = z.enum([
	"workflow-not-paused",
	"step-not-resumable",
	"text-length",
	"workflow-not-found",
]);
const epicFeedbackRejectedReasonCodeSchema = z.enum(["spec_started", "in_flight", "validation"]);

const workflowStateLikeSchema = z.custom<WorkflowState>(() => true);
const persistedEpicLikeSchema = z.custom<PersistedEpic>(() => true);
const aspectStateLikeSchema = z.custom<AspectState>(() => true);
const questionLikeSchema = z.custom<Question>(() => true);
const toolUsageLikeSchema = z.custom<ToolUsage>(() => true);
const alertLikeSchema = z.custom<Alert>(() => true);
const epicFeedbackEntryLikeSchema = z.custom<EpicFeedbackEntry>(() => true);
const epicDependencyStatusLikeSchema = z.custom<EpicDependencyStatus>(() => true);
const appConfigLikeSchema = z.custom<AppConfig>(() => true);
const configValidationErrorLikeSchema = z.custom<ConfigValidationError>(() => true);
const configWarningLikeSchema = z.custom<ConfigWarning>(() => true);
const pipelineStepNameLikeSchema = z.custom<PipelineStepName>(() => true);
const workflowStatusLikeSchema = z.custom<WorkflowStatus>(() => true);

// Two `telegram:test-result` variants share the discriminator; resolve by
// `ok`. Zod's discriminatedUnion requires unique top-level discriminator
// values, so this single variant carries `errorCode`/`reason` always —
// `null` and `""` respectively for the ok-true case. Server emissions
// must always supply both fields.
const telegramTestResultSchema = z.object({
	type: z.literal("telegram:test-result"),
	ok: z.boolean(),
	errorCode: z.union([z.number(), z.null()]),
	reason: z.string(),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("workflow:state"),
		workflow: z.union([workflowStateLikeSchema, z.null()]),
	}),
	z.object({ type: z.literal("workflow:removed"), workflowId: z.string() }),
	z.object({
		type: z.literal("workflow:list"),
		workflows: z.array(workflowStateLikeSchema),
	}),
	z.object({ type: z.literal("workflow:created"), workflow: workflowStateLikeSchema }),
	z.object({ type: z.literal("workflow:output"), workflowId: z.string(), text: z.string() }),
	z.object({
		type: z.literal("workflow:tools"),
		workflowId: z.string(),
		tools: z.array(toolUsageLikeSchema),
	}),
	z.object({
		type: z.literal("workflow:aspect:output"),
		workflowId: z.string(),
		aspectId: z.string(),
		text: z.string(),
	}),
	z.object({
		type: z.literal("workflow:aspect:tools"),
		workflowId: z.string(),
		aspectId: z.string(),
		tools: z.array(toolUsageLikeSchema),
	}),
	z.object({
		type: z.literal("workflow:aspect:state"),
		workflowId: z.string(),
		aspectId: z.string(),
		state: aspectStateLikeSchema,
	}),
	z.object({
		type: z.literal("workflow:question"),
		workflowId: z.string(),
		question: questionLikeSchema,
	}),
	z.object({
		type: z.literal("workflow:step-change"),
		workflowId: z.string(),
		previousStep: z.union([pipelineStepNameLikeSchema, z.null()]),
		currentStep: pipelineStepNameLikeSchema,
		currentStepIndex: z.number(),
		reviewIteration: z.number(),
	}),
	z.object({ type: z.literal("epic:list"), epics: z.array(persistedEpicLikeSchema) }),
	z.object({
		type: z.literal("epic:created"),
		epicId: z.string(),
		description: z.string(),
	}),
	z.object({ type: z.literal("epic:output"), epicId: z.string(), text: z.string() }),
	z.object({
		type: z.literal("epic:tools"),
		epicId: z.string(),
		tools: z.array(toolUsageLikeSchema),
	}),
	z.object({ type: z.literal("epic:summary"), epicId: z.string(), summary: z.string() }),
	z.object({
		type: z.literal("epic:result"),
		epicId: z.string(),
		title: z.string(),
		specCount: z.number(),
		workflowIds: z.array(z.string()),
		summary: z.union([z.string(), z.null()]),
	}),
	z.object({
		type: z.literal("epic:infeasible"),
		epicId: z.string(),
		title: z.string(),
		infeasibleNotes: z.string(),
	}),
	z.object({ type: z.literal("epic:error"), epicId: z.string(), message: z.string() }),
	z.object({
		type: z.literal("epic:feedback:accepted"),
		epicId: z.string(),
		entry: epicFeedbackEntryLikeSchema,
	}),
	z.object({
		type: z.literal("epic:feedback:rejected"),
		epicId: z.string(),
		reasonCode: epicFeedbackRejectedReasonCodeSchema,
		reason: z.string(),
	}),
	z.object({
		type: z.literal("epic:feedback:history"),
		epicId: z.string(),
		entries: z.array(epicFeedbackEntryLikeSchema),
		sessionContextLost: z.boolean(),
	}),
	z.object({
		type: z.literal("epic:dependency-update"),
		workflowId: z.string(),
		epicDependencyStatus: epicDependencyStatusLikeSchema,
		blockingWorkflows: z.array(z.string()),
	}),
	z.object({
		type: z.literal("epic:start-first-level:result"),
		epicId: z.string(),
		started: z.array(z.string()),
		skipped: z.array(z.string()),
		failed: z.array(z.object({ workflowId: z.string(), message: z.string() })),
	}),
	z.object({
		type: z.literal("config:state"),
		config: appConfigLikeSchema,
		warnings: z.array(configWarningLikeSchema).optional(),
	}),
	telegramTestResultSchema,
	z.object({
		type: z.literal("telegram:status"),
		unacknowledgedCount: z.number(),
		lastFailureReason: z.union([z.string(), z.null()]),
		lastFailureAt: z.union([z.number(), z.null()]),
	}),
	z.object({
		type: z.literal("default-model:info"),
		modelInfo: z.union([z.object({ modelId: z.string(), displayName: z.string() }), z.null()]),
	}),
	z.object({
		type: z.literal("config:error"),
		errors: z.array(configValidationErrorLikeSchema),
	}),
	z.object({
		type: z.literal("purge:progress"),
		step: z.string(),
		current: z.number(),
		total: z.number(),
	}),
	z.object({ type: z.literal("purge:complete"), warnings: z.array(z.string()) }),
	z.object({
		type: z.literal("purge:error"),
		message: z.string(),
		warnings: z.array(z.string()),
	}),
	z.object({
		type: z.literal("repo:clone-start"),
		submissionId: z.string(),
		owner: z.string(),
		repo: z.string(),
		reused: z.boolean(),
	}),
	z.object({
		type: z.literal("repo:clone-progress"),
		submissionId: z.string(),
		owner: z.string(),
		repo: z.string(),
		step: repoCloneStepSchema,
		message: z.string().optional(),
	}),
	z.object({
		type: z.literal("repo:clone-complete"),
		submissionId: z.string(),
		owner: z.string(),
		repo: z.string(),
		path: z.string(),
	}),
	z.object({
		type: z.literal("repo:clone-error"),
		submissionId: z.string(),
		owner: z.string(),
		repo: z.string(),
		code: repoCloneErrorCodeSchema,
		message: z.string(),
	}),
	z.object({ type: z.literal("console:output"), text: z.string() }),
	z.object({ type: z.literal("alert:list"), alerts: z.array(alertLikeSchema) }),
	z.object({ type: z.literal("alert:created"), alert: alertLikeSchema }),
	z.object({ type: z.literal("alert:dismissed"), alertIds: z.array(z.string()) }),
	z.object({ type: z.literal("alert:seen"), alertIds: z.array(z.string()) }),
	z.object({
		type: z.literal("workflow:archive-denied"),
		workflowId: z.union([z.string(), z.null()]),
		epicId: z.union([z.string(), z.null()]),
		reason: archiveDeniedReasonSchema,
		message: z.string(),
	}),
	z.object({ type: z.literal("auto-archive:state"), active: z.boolean() }),
	z.object({
		type: z.literal("workflow:feedback:ok"),
		workflowId: z.string(),
		kind: z.literal("resume-with-feedback"),
		feedbackEntryId: z.string(),
		warning: z.literal("prompt-injection-failed").optional(),
		workflowStatusAfter: z.literal("error").optional(),
	}),
	z.object({
		type: z.literal("workflow:feedback:rejected"),
		workflowId: z.string(),
		reason: workflowFeedbackRejectedReasonSchema,
		currentState: z.object({
			status: workflowStatusLikeSchema,
			currentStepIndex: z.number(),
		}),
	}),
	errorFrameSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
