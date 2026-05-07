// Client → Server messages. TS-only union for now; Zod schemas land in US2.

import type { AppConfig, DeepPartial, WorkflowKind } from "./shared-types";

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
	| { type: "workflow:finalize"; workflowId: string }
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
	| { type: "epic:pause-all"; epicId: string }
	| { type: "epic:resume-all"; epicId: string }
	| { type: "epic:abort-all"; epicId: string }
	| { type: "workflow:start-existing"; workflowId: string }
	| { type: "workflow:force-start"; workflowId: string }
	| { type: "workflow:feedback"; workflowId: string; text: string }
	| { type: "config:get" }
	| { type: "config:save"; config: DeepPartial<AppConfig> }
	| { type: "config:reset"; key?: string }
	| { type: "telegram:test"; botToken: string; chatId: string }
	| { type: "telegram:acknowledge" }
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
