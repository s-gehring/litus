// Client → Server messages. Zod schemas + TS types via `z.infer<>`.
//
// Complex nested fields (`config: DeepPartial<AppConfig>`) use
// `z.record(z.unknown())` for v1; tightening these to fully-typed
// nested schemas is a follow-up under the same FR-016 contract suite.

import { z } from "zod";

const workflowKindSchema = z.enum(["spec", "quick-fix", "ask-question"]);

export const clientMessageSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("workflow:start"),
		specification: z.string(),
		targetRepository: z.string().optional(),
		submissionId: z.string().optional(),
		workflowKind: workflowKindSchema.optional(),
	}),
	z.object({
		type: z.literal("workflow:answer"),
		workflowId: z.string(),
		questionId: z.string(),
		answer: z.string(),
	}),
	z.object({
		type: z.literal("workflow:skip"),
		workflowId: z.string(),
		questionId: z.string(),
	}),
	z.object({ type: z.literal("workflow:pause"), workflowId: z.string() }),
	z.object({ type: z.literal("workflow:resume"), workflowId: z.string() }),
	z.object({ type: z.literal("workflow:abort"), workflowId: z.string() }),
	z.object({ type: z.literal("workflow:retry"), workflowId: z.string() }),
	z.object({ type: z.literal("workflow:retry-workflow"), workflowId: z.string() }),
	z.object({ type: z.literal("workflow:finalize"), workflowId: z.string() }),
	z.object({
		type: z.literal("epic:start"),
		description: z.string(),
		targetRepository: z.string().optional(),
		autoStart: z.boolean(),
		submissionId: z.string().optional(),
	}),
	z.object({ type: z.literal("epic:abort") }),
	z.object({ type: z.literal("epic:feedback"), epicId: z.string(), text: z.string() }),
	z.object({ type: z.literal("epic:feedback:ack-context-lost"), epicId: z.string() }),
	z.object({ type: z.literal("epic:start-first-level"), epicId: z.string() }),
	z.object({ type: z.literal("epic:pause-all"), epicId: z.string() }),
	z.object({ type: z.literal("epic:resume-all"), epicId: z.string() }),
	z.object({ type: z.literal("epic:abort-all"), epicId: z.string() }),
	z.object({ type: z.literal("workflow:start-existing"), workflowId: z.string() }),
	z.object({ type: z.literal("workflow:force-start"), workflowId: z.string() }),
	z.object({ type: z.literal("workflow:feedback"), workflowId: z.string(), text: z.string() }),
	z.object({ type: z.literal("config:get") }),
	z.object({ type: z.literal("config:save"), config: z.record(z.string(), z.unknown()) }),
	z.object({ type: z.literal("config:reset"), key: z.string().optional() }),
	z.object({ type: z.literal("telegram:test"), botToken: z.string(), chatId: z.string() }),
	z.object({ type: z.literal("telegram:acknowledge") }),
	z.object({ type: z.literal("alert:list") }),
	z.object({ type: z.literal("alert:dismiss"), alertId: z.string() }),
	z.object({ type: z.literal("alert:clear-all") }),
	z.object({ type: z.literal("alert:route-changed"), path: z.string() }),
	z.object({ type: z.literal("workflow:archive"), workflowId: z.string() }),
	z.object({ type: z.literal("workflow:unarchive"), workflowId: z.string() }),
	z.object({ type: z.literal("epic:archive"), epicId: z.string() }),
	z.object({ type: z.literal("epic:unarchive"), epicId: z.string() }),
	z.object({ type: z.literal("auto-archive:stop") }),
	z.object({ type: z.literal("auto-archive:start") }),
	z.object({ type: z.literal("purge:all") }),
	z.object({ type: z.literal("client:warning"), source: z.string(), message: z.string() }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
