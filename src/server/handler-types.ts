import type { ServerWebSocket } from "bun";
import type { AlertQueue } from "../alert-queue";
import type { AuditLogger } from "../audit-logger";
import type { CLIRunner } from "../cli-runner";
import type { ConfigStore } from "../config-store";
import type { EpicAnalysisProcess } from "../epic-analyzer";
import type { EpicStore } from "../epic-store";
import { logger } from "../logger";
import type { ManagedRepoStore } from "../managed-repo-store";
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
	managedRepoStore: ManagedRepoStore;
	alertQueue: AlertQueue;
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
export function validateTextInput(
	value: string,
	label: string,
	options: { minLength?: number; emptyMessage?: string } = {},
): string | null {
	const minLength = options.minLength ?? 1;
	if (!value || value.trim().length < minLength) {
		if (options.emptyMessage) return options.emptyMessage;
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

/**
 * Resolve a target repo input to an effective local path.
 *
 * - For local-path inputs, behaves like `validateRepo` and returns `{ path, managedRepo: null }`.
 * - For GitHub URL inputs, acquires a managed clone via `deps.managedRepoStore`, broadcasting
 *   `repo:clone-*` events keyed by `submissionId`. On clone failure, emits `repo:clone-error`
 *   and returns `null` (no workflow record should be created).
 * - For non-GitHub URL inputs, emits `repo:clone-error` with code `non-github-url` and returns `null`.
 */
export async function resolveTargetRepo(
	targetRepository: string | undefined,
	submissionId: string | undefined,
	ws: ServerWebSocket<WsData>,
	deps: HandlerDeps,
): Promise<{ path: string; managedRepo: { owner: string; repo: string } | null } | null> {
	if (!targetRepository) {
		deps.sendTo(ws, { type: "error", message: "Target repository is required" });
		return null;
	}

	const validation = await validateTargetRepository(targetRepository);

	if (validation.kind === "url" && validation.valid) {
		// The client keys its in-progress "Cloning…" modal by `submissionId`, so a
		// URL-kind input without one would silently drop all `repo:clone-*`
		// progress/error events (the client registers nothing at an empty key).
		// Surface that as a user-visible error instead of a hang.
		if (!submissionId) {
			deps.sendTo(ws, {
				type: "error",
				message: "Missing submissionId — URL inputs require a client-generated submissionId.",
			});
			return null;
		}
		const sid = submissionId;
		// Validator guarantees owner/repo are set when kind === "url" && valid.
		const owner = validation.owner as string;
		const repo = validation.repo as string;
		try {
			const result = await deps.managedRepoStore.acquire(targetRepository, {
				onStart: (o, r, reused) =>
					deps.broadcast({
						type: "repo:clone-start",
						submissionId: sid,
						owner: o,
						repo: r,
						reused,
					}),
				onProgress: (step, message) =>
					deps.broadcast({
						type: "repo:clone-progress",
						submissionId: sid,
						owner,
						repo,
						step,
						message,
					}),
			});
			deps.broadcast({
				type: "repo:clone-complete",
				submissionId: sid,
				owner: result.owner,
				repo: result.repo,
				path: result.path,
			});
			return {
				path: result.path,
				managedRepo: { owner: result.owner, repo: result.repo },
			};
		} catch (err) {
			const code = (err as { code?: string }).code as
				| "non-github-url"
				| "clone-failed"
				| "auth-required"
				| "not-found"
				| "network"
				| "unknown"
				| undefined;
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(`[ws] repo clone failed (${owner}/${repo}): ${message}`);
			deps.sendTo(ws, {
				type: "repo:clone-error",
				submissionId: sid,
				owner,
				repo,
				code: code ?? "unknown",
				message,
			});
			return null;
		}
	}

	if (!validation.valid) {
		if (validation.code === "non-github-url") {
			// Same reasoning as the URL branch above: without a submissionId the
			// client would never see the clone-error event.
			if (!submissionId) {
				deps.sendTo(ws, {
					type: "error",
					message: "Missing submissionId — URL inputs require a client-generated submissionId.",
				});
				return null;
			}
			deps.sendTo(ws, {
				type: "repo:clone-error",
				submissionId,
				owner: "",
				repo: "",
				code: "non-github-url",
				message: validation.error ?? "Only GitHub URLs are supported",
			});
			return null;
		}
		deps.sendTo(ws, { type: "error", message: validation.error ?? "Invalid target repository" });
		return null;
	}

	// A path input that points at a currently-managed clone (e.g. the client
	// prefilled the previous workflow's `targetRepository`, which for a
	// URL-submitted workflow is the clone path under ~/.litus/repos) must
	// participate in refcounting. Otherwise the first workflow's release
	// would delete the folder this new workflow is about to work inside.
	const attached = await deps.managedRepoStore.tryAttachByPath(validation.effectivePath);
	if (attached) {
		return { path: validation.effectivePath, managedRepo: attached };
	}
	return { path: validation.effectivePath, managedRepo: null };
}
