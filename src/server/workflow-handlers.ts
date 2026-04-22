import { basename } from "node:path";
import { toErrorMessage } from "../errors";
import { logger } from "../logger";
import { getMimeType } from "../static-files";
import { type ClientMessage, STEP, type Workflow } from "../types";
import {
	getArtifactSnapshotPath,
	getWorkflowBranch,
	listArtifacts,
	lookupArtifact,
	sanitizeBranchForFilename,
} from "../workflow-artifacts";
import { resetWorkflow } from "../workflow-engine";
import type { HandlerDeps, MessageHandler } from "./handler-types";
import { resolveTargetRepo, validateTextInput, withOrchestrator } from "./handler-types";

// Per-workflow dedupe guard for `workflow:retry-workflow`. A second click while
// the reset is still running is a no-op: the ordered cleanup is already in
// progress and the outcome will broadcast when it resolves.
const retryWorkflowInFlight = new Set<string>();

export const handleStart: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "workflow:start" };
	const { specification, targetRepository, submissionId, workflowKind } = msg;

	if (typeof specification !== "string") {
		// Distinct from the empty-string case: the input is missing or of the wrong
		// type, not merely blank. `validateTextInput` assumes a string, so we can't
		// delegate this branch to it without changing its signature.
		deps.sendTo(ws, {
			type: "error",
			message:
				workflowKind === "quick-fix"
					? "Quick Fix description is required"
					: "Specification is required",
		});
		return;
	}
	const inputError =
		workflowKind === "quick-fix"
			? validateTextInput(specification, "Quick Fix description", {
					emptyMessage: "Quick Fix description must not be empty.",
				})
			: validateTextInput(specification, "Specification");
	if (inputError) {
		deps.sendTo(ws, { type: "error", message: inputError });
		return;
	}

	const resolved = await resolveTargetRepo(targetRepository, submissionId, ws, deps);
	if (!resolved) return;

	let committed = false;
	try {
		const orch = deps.createOrchestrator();
		const workflow = await orch.startPipeline(
			specification.trim(),
			resolved.path,
			resolved.managedRepo ?? null,
			{ workflowKind: workflowKind ?? "spec" },
		);
		deps.orchestrators.set(workflow.id, orch);
		committed = true;

		const state = deps.stripInternalFields(workflow);
		deps.broadcast({ type: "workflow:created", workflow: state });
	} catch (err) {
		const message = toErrorMessage(err);
		logger.error("[ws] workflow:start failed:", err);
		deps.sendTo(ws, { type: "error", message });
	} finally {
		if (!committed && resolved.managedRepo) {
			await deps.managedRepoStore
				.release(resolved.managedRepo.owner, resolved.managedRepo.repo)
				.catch((relErr) => {
					logger.warn(`[ws] managed-repo release after failed workflow:start: ${relErr}`);
				});
		}
	}
};

export const handleAnswer: MessageHandler = withOrchestrator((ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:answer" };
	const { workflowId, questionId, answer } = msg;

	const inputError = validateTextInput(answer, "Answer");
	if (inputError) {
		deps.sendTo(ws, { type: "error", message: inputError });
		return;
	}

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow?.pendingQuestion || workflow.pendingQuestion.id !== questionId) {
		deps.sendTo(ws, { type: "error", message: "Question not found or already answered" });
		return;
	}

	orch.answerQuestion(workflowId, questionId, answer.trim());
});

export const handleSkip: MessageHandler = withOrchestrator((ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:skip" };
	const { workflowId, questionId } = msg;

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow?.pendingQuestion || workflow.pendingQuestion.id !== questionId) {
		deps.sendTo(ws, { type: "error", message: "Question not found or already answered" });
		return;
	}

	orch.skipQuestion(workflowId, questionId);
});

export const handlePause: MessageHandler = withOrchestrator((_ws, data, _deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:pause" };
	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "running") return;
	orch.pause(msg.workflowId);
});

export const handleResume: MessageHandler = withOrchestrator((_ws, data, _deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:resume" };
	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "paused") return;
	orch.resume(msg.workflowId);
});

export const handleAbort: MessageHandler = withOrchestrator((_ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:abort" };
	const { workflowId } = msg;
	const workflow = orch.getEngine().getWorkflow();
	if (!workflow) return;

	// `error` is accepted here because the user needs a way to move an errored
	// workflow to a terminal state: without it the managed-repo refcount stays
	// held forever (error is no longer terminal for refcount purposes), and the
	// only exit would be a full purge. Aborting from `error` releases the
	// refcount via the normal abort path.
	if (
		workflow.status !== "paused" &&
		workflow.status !== "waiting_for_input" &&
		workflow.status !== "waiting_for_dependencies" &&
		workflow.status !== "error"
	) {
		return;
	}

	orch.abortPipeline(workflowId);
	deps.orchestrators.delete(workflowId);
});

export const handleRetry: MessageHandler = withOrchestrator((ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:retry" };
	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "error") {
		deps.sendTo(ws, { type: "error", message: "No failed step to retry" });
		return;
	}
	orch.retryStep(msg.workflowId);
});

export const handleRetryWorkflow: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "workflow:retry-workflow" };
	const { workflowId } = msg;

	if (!workflowId) {
		deps.sendTo(ws, {
			type: "error",
			requestType: "workflow:retry-workflow",
			code: "not_found",
			message: "Missing workflowId",
		});
		return;
	}

	if (retryWorkflowInFlight.has(workflowId)) {
		// Drop duplicate sends while an ordered cleanup is already in flight; the
		// outcome broadcast is the single source of truth.
		return;
	}

	// Acquire the dedupe guard synchronously, BEFORE any await — otherwise a
	// rapid-fire second send could slip past the `has()` check while the first
	// call is still awaiting `sharedStore.load`.
	retryWorkflowInFlight.add(workflowId);
	try {
		// Active orchestrator (error state) or persisted record (aborted state —
		// which isn't restored into `orchestrators` on startup).
		const orch = deps.orchestrators.get(workflowId);
		const liveWorkflow = orch?.getEngine().getWorkflow();
		const workflow: Workflow | null = liveWorkflow ?? (await deps.sharedStore.load(workflowId));

		if (!workflow) {
			deps.sendTo(ws, {
				type: "error",
				requestType: "workflow:retry-workflow",
				code: "not_found",
				message: `Workflow ${workflowId} not found`,
			});
			return;
		}

		if (workflow.status !== "error" && workflow.status !== "aborted") {
			deps.sendTo(ws, {
				type: "error",
				requestType: "workflow:retry-workflow",
				code: "invalid_state",
				message: "Retry workflow is only available from error or aborted state.",
			});
			return;
		}

		// Capture pre-reset targets for the audit event — the reset mutates these
		// fields in place on success, so we snapshot them before the call.
		const preResetBranch = workflow.worktreeBranch ?? "";
		const preResetWorktreePath = workflow.worktreePath ?? "";
		const outcome = await resetWorkflow(workflow);

		// Persist FIRST, then audit + broadcast — only on persist success.
		// If we audited/broadcast before persistence and the save failed, the
		// audit log would claim the reset happened while the on-disk record
		// still showed the pre-reset state, and the `aborted` → broadcast
		// fallback (which reads from the store) would then contradict the
		// audit. Keep the three side-effects consistent with the persisted
		// truth by gating them on `save` success.
		try {
			await deps.sharedStore.save(workflow);
		} catch (err) {
			logger.error(`[ws] workflow:retry-workflow persist failed: ${err}`);
			deps.sendTo(ws, {
				type: "error",
				requestType: "workflow:retry-workflow",
				code: "persist_failed",
				message: "Could not persist reset — please retry.",
			});
			return;
		}

		// Keep in-memory orchestrator (if any) in sync so later WS reads see the
		// reset state. Aborted workflows were removed from the orchestrators map
		// by `handleAbort`; without re-registering here a follow-up `Start`
		// action would fail in `withOrchestrator` with "Workflow not found",
		// leaving the operator with an idle workflow they cannot launch.
		if (orch) {
			orch.getEngine().setWorkflow(workflow);
		} else if (outcome.partialFailure === false) {
			const newOrch = deps.createOrchestrator();
			newOrch.getEngine().setWorkflow(workflow);
			deps.orchestrators.set(workflow.id, newOrch);
		}

		// Audit event — pipeline name follows the existing convention (feature
		// branch when present, otherwise the managed `tmp-<shortId>` branch).
		const pipelineName = workflow.featureBranch ?? workflow.worktreeBranch ?? workflow.id;
		deps.sharedAuditLogger.logWorkflowReset({
			pipelineName,
			workflowId: workflow.id,
			epicId: workflow.epicId,
			branch: preResetBranch,
			worktreePath: preResetWorktreePath,
			artifactCount: outcome.artifacts.removed,
			partialFailure: outcome.partialFailure,
		});

		deps.broadcastWorkflowState(workflowId);
	} finally {
		retryWorkflowInFlight.delete(workflowId);
	}
};

export const handleStartExisting: MessageHandler = withOrchestrator((ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:start-existing" };
	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "idle") {
		deps.sendTo(ws, { type: "error", message: "Workflow is not idle" });
		return;
	}

	try {
		orch.startPipelineFromWorkflow(workflow);
	} catch (err) {
		logger.error("[ws] workflow:start-existing failed:", err);
		deps.sendTo(ws, { type: "error", message: `Failed to start workflow: ${err}` });
		return;
	}
	deps.broadcastWorkflowState(msg.workflowId);
});

const FEEDBACK_INELIGIBLE_MSG = "Workflow is not paused at a feedback-eligible step";
const FEEDBACK_MAX_LENGTH = 100_000;

export const handleFeedback: MessageHandler = withOrchestrator((ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:feedback" };
	const { workflowId, text } = msg;

	if (typeof text !== "string") {
		deps.sendTo(ws, { type: "error", message: "Feedback text is required" });
		return;
	}
	if (text.length > FEEDBACK_MAX_LENGTH) {
		deps.sendTo(ws, {
			type: "error",
			message: `Feedback exceeds maximum length (${FEEDBACK_MAX_LENGTH.toLocaleString()} characters)`,
		});
		return;
	}

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow) {
		deps.sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	const step = workflow.steps[workflow.currentStepIndex];

	// FR-016: an errored fix-implement step accepts appended feedback regardless
	// of autoMode — the appended text is treated as retry guidance for the next
	// fix-implement run.
	const isErroredFixImplement = workflow.status === "error" && step?.name === STEP.FIX_IMPLEMENT;

	if (!isErroredFixImplement) {
		// Contract: feedback (including the empty-resume path) is only valid at the
		// manual-mode merge-pr pause. Validate uniformly before branching on text.
		if (workflow.status !== "paused") {
			deps.sendTo(ws, { type: "error", message: FEEDBACK_INELIGIBLE_MSG });
			return;
		}
		if (step?.name !== STEP.MERGE_PR) {
			deps.sendTo(ws, { type: "error", message: FEEDBACK_INELIGIBLE_MSG });
			return;
		}
		if (deps.configStore.get().autoMode !== "manual") {
			deps.sendTo(ws, { type: "error", message: FEEDBACK_INELIGIBLE_MSG });
			return;
		}
	}

	// Empty → Resume for the paused/merge-pr path. For an errored fix-implement,
	// empty feedback is not a valid retry trigger.
	if (text.trim() === "") {
		if (isErroredFixImplement) {
			deps.sendTo(ws, {
				type: "error",
				message: "Feedback text is required to retry fix-implement with context",
			});
			return;
		}
		orch.resume(workflowId);
		return;
	}

	if (workflow.feedbackEntries.some((e) => e.outcome === null)) {
		deps.sendTo(ws, {
			type: "error",
			message: "A feedback iteration is already in progress",
		});
		return;
	}

	try {
		orch.submitFeedback(workflowId, text);
	} catch (err) {
		logger.error("[ws] workflow:feedback failed:", err);
		deps.sendTo(ws, {
			type: "error",
			message: `Failed to submit feedback: ${toErrorMessage(err)}`,
		});
	}
});

// ── HTTP artifact handlers ──────────────────────────────

async function loadWorkflow(
	workflowId: string,
	deps: Pick<HandlerDeps, "orchestrators" | "sharedStore">,
): Promise<Workflow | null> {
	const orch = deps.orchestrators.get(workflowId);
	const live = orch?.getEngine().getWorkflow();
	if (live) return live;
	return deps.sharedStore.load(workflowId);
}

function jsonError(status: number, code: string): Response {
	return new Response(JSON.stringify({ error: code }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export async function handleArtifactList(
	workflowId: string,
	deps: Pick<HandlerDeps, "orchestrators" | "sharedStore">,
): Promise<Response> {
	const workflow = await loadWorkflow(workflowId, deps);
	if (!workflow) return jsonError(404, "workflow_not_found");
	const response = listArtifacts(workflow);
	return Response.json(response);
}

async function resolveArtifactAbsolutePath(
	workflowId: string,
	artifactId: string,
	deps: Pick<HandlerDeps, "orchestrators" | "sharedStore">,
): Promise<
	| {
			kind: "ok";
			absPath: string;
			workflow: Workflow;
			basename: string;
			contentType: string;
	  }
	| { kind: "error"; response: Response }
> {
	const entry = lookupArtifact(artifactId);
	if (!entry || entry.workflowId !== workflowId) {
		return { kind: "error", response: jsonError(404, "artifact_unavailable") };
	}
	const workflow = await loadWorkflow(workflowId, deps);
	if (!workflow) {
		return { kind: "error", response: jsonError(404, "workflow_not_found") };
	}
	const absPath = getArtifactSnapshotPath(workflowId, entry.step, entry.runOrdinal, entry.relPath);
	if (!absPath) {
		return { kind: "error", response: jsonError(400, "invalid_artifact") };
	}
	const file = Bun.file(absPath);
	if (!(await file.exists())) {
		return { kind: "error", response: jsonError(404, "artifact_unavailable") };
	}
	const base = basename(entry.relPath);
	// Artifacts-step entries may carry a manifest-declared MIME hint — honour
	// it so e.g. a custom content type for a vendor-specific report format
	// survives the round-trip. Other steps fall back to extension inference.
	const contentType = entry.contentType ?? getMimeType(base);
	return { kind: "ok", absPath, workflow, basename: base, contentType };
}

export async function handleArtifactContent(
	workflowId: string,
	artifactId: string,
	deps: Pick<HandlerDeps, "orchestrators" | "sharedStore">,
): Promise<Response> {
	const resolved = await resolveArtifactAbsolutePath(workflowId, artifactId, deps);
	if (resolved.kind === "error") return resolved.response;
	const file = Bun.file(resolved.absPath);
	return new Response(file.stream(), {
		headers: {
			"Content-Type": resolved.contentType,
			"Cache-Control": "no-store",
			"Content-Length": String(file.size),
		},
	});
}

export async function handleArtifactDownload(
	workflowId: string,
	artifactId: string,
	deps: Pick<HandlerDeps, "orchestrators" | "sharedStore">,
): Promise<Response> {
	const resolved = await resolveArtifactAbsolutePath(workflowId, artifactId, deps);
	if (resolved.kind === "error") return resolved.response;
	const branch = getWorkflowBranch(resolved.workflow);
	const sanitized = sanitizeBranchForFilename(branch);
	const filename = sanitized ? `${sanitized}-${resolved.basename}` : resolved.basename;
	const encoded = encodeURIComponent(filename);
	// Escape backslash and double-quote in the quoted-string fallback; the
	// basename comes from server-controlled sources today, but the invariant
	// isn't locally visible, so harden the quoting rather than rely on it.
	const quoted = filename.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const file = Bun.file(resolved.absPath);
	return new Response(file.stream(), {
		headers: {
			"Content-Type": resolved.contentType,
			"Cache-Control": "no-store",
			"Content-Length": String(file.size),
			"Content-Disposition": `attachment; filename="${quoted}"; filename*=UTF-8''${encoded}`,
		},
	});
}

export const handleForceStart: MessageHandler = withOrchestrator((ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:force-start" };
	const { workflowId } = msg;
	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "waiting_for_dependencies") {
		deps.sendTo(ws, { type: "error", message: "Workflow is not waiting for dependencies" });
		return;
	}

	workflow.epicDependencyStatus = "overridden";
	workflow.updatedAt = new Date().toISOString();

	try {
		orch.startPipelineFromWorkflow(workflow);
	} catch (err) {
		logger.error("[ws] workflow:force-start failed:", err);
		workflow.epicDependencyStatus = "waiting";
		deps.sendTo(ws, { type: "error", message: `Failed to force-start workflow: ${err}` });
		return;
	}
	deps.broadcastWorkflowState(workflowId);
});
