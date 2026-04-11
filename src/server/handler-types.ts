import type { ServerWebSocket } from "bun";
import type { AuditLogger } from "../audit-logger";
import type { CLIRunner } from "../cli-runner";
import type { ConfigStore } from "../config-store";
import type { EpicAnalysisProcess } from "../epic-analyzer";
import type { EpicStore } from "../epic-store";
import { logger } from "../logger";
import type { PipelineOrchestrator } from "../pipeline-orchestrator";
import type { Summarizer } from "../summarizer";
import { validateTargetRepository } from "../target-repo-validator";
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
			logger.warn(`[ws] Missing workflowId in ${data.type} message`);
			deps.sendTo(ws, { type: "error", message: "Missing workflowId" });
			return;
		}
		const orch = deps.orchestrators.get(workflowId);
		if (!orch) {
			logger.warn(`[ws] Workflow not found: ${workflowId} (${data.type})`);
			deps.sendTo(ws, { type: "error", message: "Workflow not found" });
			return;
		}
		return handler(ws, data as ClientMessage & { workflowId: string }, deps, orch);
	};
}

const MAX_INPUT_LENGTH = 100_000;

/** Validate a text input is non-empty and under the max length. Returns an error message or null. */
export function validateTextInput(value: string, label: string, minLength = 1): string | null {
	if (!value || value.trim().length < minLength) {
		return minLength > 1
			? `${label} must be at least ${minLength} characters`
			: `${label} must be non-empty`;
	}
	if (value.length > MAX_INPUT_LENGTH) {
		return `${label} exceeds maximum length (${MAX_INPUT_LENGTH.toLocaleString()} characters)`;
	}
	return null;
}

/** Validate a target repository path. Returns the effective path or sends an error. */
export async function validateRepo(
	targetRepository: string | undefined,
	ws: ServerWebSocket<WsData>,
	deps: HandlerDeps,
): Promise<string | null> {
	if (!targetRepository) {
		deps.sendTo(ws, { type: "error", message: "Target repository is required" });
		return null;
	}
	const validation = await validateTargetRepository(targetRepository);
	if (!validation.valid) {
		deps.sendTo(ws, { type: "error", message: validation.error ?? "Invalid target repository" });
		return null;
	}
	return validation.effectivePath;
}
