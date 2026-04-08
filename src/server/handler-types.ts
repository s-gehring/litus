import type { ServerWebSocket } from "bun";
import type { AuditLogger } from "../audit-logger";
import type { CLIRunner } from "../cli-runner";
import type { ConfigStore } from "../config-store";
import type { EpicAnalysisProcess } from "../epic-analyzer";
import type { EpicStore } from "../epic-store";
import type { PipelineOrchestrator } from "../pipeline-orchestrator";
import type { Summarizer } from "../summarizer";
import type { ClientMessage, ServerMessage, Workflow, WorkflowState } from "../types";
import type { WorkflowStore } from "../workflow-store";

export type WsData = Record<string, never>;

export interface HandlerDeps {
	orchestrators: Map<string, PipelineOrchestrator>;
	broadcast: (msg: ServerMessage) => void;
	sendTo: (ws: ServerWebSocket<WsData>, msg: ServerMessage) => void;
	sharedStore: WorkflowStore;
	sharedEpicStore: EpicStore;
	sharedAuditLogger: AuditLogger;
	sharedCliRunner: CLIRunner;
	sharedSummarizer: Summarizer;
	configStore: ConfigStore;
	epicAnalysisRef: { current: EpicAnalysisProcess | null };
	createOrchestrator: () => PipelineOrchestrator;
	broadcastWorkflowState: (workflowId: string) => void;
	stripInternalFields: (w: Workflow) => WorkflowState;
	getAllWorkflowStates: () => Promise<WorkflowState[]>;
}

export type MessageHandler = (
	ws: ServerWebSocket<WsData>,
	data: ClientMessage,
	deps: HandlerDeps,
) => void | Promise<void>;

/**
 * Higher-order helper that wraps a handler requiring an orchestrator lookup.
 * Extracts workflowId from message data, looks up the orchestrator, and either
 * calls the inner handler with the resolved orchestrator or sends an error.
 */
export function withOrchestrator(
	handler: (
		ws: ServerWebSocket<WsData>,
		data: ClientMessage & { workflowId: string },
		deps: HandlerDeps,
		orch: PipelineOrchestrator,
	) => void | Promise<void>,
): MessageHandler {
	return (ws, data, deps) => {
		const { workflowId } = data as { workflowId?: string };
		if (!workflowId) {
			deps.sendTo(ws, { type: "error", message: "Missing workflowId" });
			return;
		}
		const orch = deps.orchestrators.get(workflowId);
		if (!orch) {
			deps.sendTo(ws, { type: "error", message: "Workflow not found" });
			return;
		}
		return handler(ws, data as ClientMessage & { workflowId: string }, deps, orch);
	};
}
