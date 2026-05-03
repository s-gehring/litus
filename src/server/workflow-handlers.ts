import { basename } from "node:path";
import { toErrorMessage } from "../errors";
import { logger } from "../logger";
import { STEP } from "../pipeline-steps";
import type { ClientMessage } from "../protocol";
import { getMimeType } from "../static-files";
import { ASK_QUESTION_MAX_LENGTH, type Workflow } from "../types";
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
		const requiredLabel =
			workflowKind === "quick-fix"
				? "Quick Fix description"
				: workflowKind === "ask-question"
					? "Question"
					: "Specification";
		deps.sendTo(ws, {
			type: "error",
			message: `${requiredLabel} is required`,
		});
		return;
	}
	const inputError =
		workflowKind === "quick-fix"
			? validateTextInput(specification, "Quick Fix description", {
					emptyMessage: "Quick Fix description must not be empty.",
				})
			: workflowKind === "ask-question"
				? validateTextInput(specification, "Question", {
						emptyMessage: "Please enter a question.",
						maxLength: ASK_QUESTION_MAX_LENGTH,
						overLimitMessage: `Question is too long. The maximum allowed length is ${ASK_QUESTION_MAX_LENGTH.toLocaleString("en-US")} characters; this is a guardrail against the LLM token budget.`,
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
		// leaving the operator with an idle workflow they cannot launch. Do
		// this unconditionally — a partial cleanup failure leaves the workflow
		// in `error` state, and the operator still needs the orch present to
		// issue the next retry (otherwise the retry itself would then create
		// one, but any UI path that reaches `withOrchestrator` in between —
		// e.g. state reads — would misleadingly report "not found").
		const liveOrch = orch ?? deps.createOrchestrator();
		liveOrch.getEngine().setWorkflow(workflow);
		if (!orch) {
			deps.orchestrators.set(workflow.id, liveOrch);
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

		// Auto-relaunch standalone workflows after a clean reset. Without this
		// step a non-epic workflow (e.g. ask-question) lands in `idle` with no
		// UI control to leave it: the Start button only renders for
		// epic-attached workflows, since epic children may be gated by sibling
		// dependencies. A standalone workflow has no such gate, so the user's
		// "Restart" click would otherwise silently strand the workflow at idle.
		// Skip on partial cleanup (resetWorkflow leaves status === "error")
		// so the operator can re-issue Restart instead of immediately
		// re-running atop a half-cleaned worktree.
		if (!outcome.partialFailure && workflow.epicId === null) {
			try {
				liveOrch.startPipelineFromWorkflow(workflow);
			} catch (err) {
				logger.error(`[ws] workflow:retry-workflow auto-start failed: ${err}`);
			}
		}

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

	// Dispatch table (top-down; first match wins; FR-011 precedence rule).
	// The order of these checks is the contract: the new resume-with-feedback
	// flow (row 3) MUST NOT pre-empt the two existing specialized flows that
	// the spec promises will keep working unchanged (SC-002, SC-003).
	// Row 1: paused + merge-pr + manual → existing manual-mode merge-PR iteration loop.
	// Row 2: error + fix-implement → existing fix-implement retry-context append.
	// Row 3: paused + currentStep.sessionId non-empty (and not row 1) → resume-with-feedback (NEW).
	// Row 4: anything else → reject with `workflow:feedback:rejected`.
	const autoMode = deps.configStore.get().autoMode;
	const isMergePrIteration =
		workflow.status === "paused" && step?.name === STEP.MERGE_PR && autoMode === "manual";
	const isFixImplementRetry = workflow.status === "error" && step?.name === STEP.FIX_IMPLEMENT;
	const isResumeWithFeedback =
		!isMergePrIteration &&
		workflow.status === "paused" &&
		step?.sessionId !== undefined &&
		step?.sessionId !== null &&
		step.sessionId !== "";

	if (isMergePrIteration || isFixImplementRetry) {
		// Empty text routes to plain resume on row 1 (existing semantics); empty
		// text on row 2 (errored fix-implement) is not a valid retry trigger.
		if (text.trim() === "") {
			if (isFixImplementRetry) {
				deps.sendTo(ws, {
					type: "error",
					message: "Feedback text is required to retry fix-implement with context",
				});
				return;
			}
			orch.resume(workflowId);
			return;
		}
		// Only the merge-PR iteration loop and fix-implement retry loop track
		// outcomes — a resume-with-feedback entry has no follow-up step that
		// would set its outcome, so it is excluded from this in-flight guard.
		if (
			workflow.feedbackEntries.some((e) => e.outcome === null && e.kind !== "resume-with-feedback")
		) {
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
		return;
	}

	if (isResumeWithFeedback) {
		const result = orch.submitResumeWithFeedback(workflowId, text);
		if (!result.ok) {
			deps.sendTo(ws, {
				type: "workflow:feedback:rejected",
				workflowId,
				reason: result.reason,
				currentState: result.currentState,
			});
			return;
		}
		if (result.warning) {
			deps.sendTo(ws, {
				type: "workflow:feedback:ok",
				workflowId,
				kind: "resume-with-feedback",
				feedbackEntryId: result.feedbackEntryId,
				warning: result.warning,
				workflowStatusAfter: result.workflowStatusAfter,
			});
		} else {
			deps.sendTo(ws, {
				type: "workflow:feedback:ok",
				workflowId,
				kind: "resume-with-feedback",
				feedbackEntryId: result.feedbackEntryId,
			});
		}
		return;
	}

	// Ask-question iteration: paused at the `answer` step on an ask-question
	// workflow. Reuses the `workflow:feedback` channel and routes through the
	// orchestrator's dedicated submitAskQuestionFeedback entry point.
	if (
		workflow.workflowKind === "ask-question" &&
		workflow.status === "waiting_for_input" &&
		step?.name === STEP.ANSWER
	) {
		if (text.trim() === "") {
			deps.sendTo(ws, { type: "error", message: "Feedback text is required" });
			return;
		}
		const result = orch.submitAskQuestionFeedback(workflowId, text.trim());
		if (!result.ok) {
			deps.sendTo(ws, {
				type: "error",
				message: result.reason,
			});
			return;
		}
		// No specialized ack message; the workflow:state broadcast carries the
		// new feedback entry + answer when synthesis completes.
		return;
	}

	// Row 4: reject — no specialized flow matched. Pick the most specific reason.
	const row4Reason: "workflow-not-paused" | "step-not-resumable" =
		workflow.status !== "paused" ? "workflow-not-paused" : "step-not-resumable";
	deps.sendTo(ws, {
		type: "workflow:feedback:rejected",
		workflowId,
		reason: row4Reason,
		currentState: { status: workflow.status, currentStepIndex: workflow.currentStepIndex },
	});
});

export const handleFinalize: MessageHandler = withOrchestrator((ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:finalize" };
	const { workflowId } = msg;
	const result = orch.submitFinalize(workflowId);
	if (!result.ok) {
		deps.sendTo(ws, {
			type: "error",
			message: result.reason,
			code: result.reason === "not_found" ? "not_found" : "invalid_state",
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

export async function loadWorkflowForArchive(
	workflowId: string,
	deps: HandlerDeps,
): Promise<Workflow | null> {
	const orch = deps.orchestrators.get(workflowId);
	const live = orch?.getEngine().getWorkflow();
	if (live) return live;
	return deps.sharedStore.load(workflowId);
}

/**
 * Persist an archive flip described by `next` and, only on save success, apply
 * the mutation to the in-memory workflow object (and any live orchestrator
 * copy). If the save throws, the in-memory state is untouched so a subsequent
 * broadcast cannot advertise a ghost-archived workflow.
 */
export async function persistArchiveFlip(
	workflow: Workflow,
	next: {
		archived: boolean;
		archivedAt: string | null;
		updatedAt: string;
		autoArchiveExempt?: boolean;
	},
	deps: HandlerDeps,
): Promise<void> {
	const orch = deps.orchestrators.get(workflow.id);
	const live = orch?.getEngine().getWorkflow();
	const target = live && live !== workflow ? live : workflow;
	const snapshot = {
		archived: target.archived,
		archivedAt: target.archivedAt,
		updatedAt: target.updatedAt,
		autoArchiveExempt: target.autoArchiveExempt,
	};
	target.archived = next.archived;
	target.archivedAt = next.archivedAt;
	target.updatedAt = next.updatedAt;
	if (next.autoArchiveExempt !== undefined) {
		target.autoArchiveExempt = next.autoArchiveExempt;
	}
	try {
		await deps.sharedStore.save(target);
	} catch (err) {
		target.archived = snapshot.archived;
		target.archivedAt = snapshot.archivedAt;
		target.updatedAt = snapshot.updatedAt;
		target.autoArchiveExempt = snapshot.autoArchiveExempt;
		throw err;
	}
	if (target !== workflow) {
		workflow.archived = next.archived;
		workflow.archivedAt = next.archivedAt;
		workflow.updatedAt = next.updatedAt;
		if (next.autoArchiveExempt !== undefined) {
			workflow.autoArchiveExempt = next.autoArchiveExempt;
		}
	}
}

export const handleArchiveWorkflow: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "workflow:archive" };
	const { workflowId } = msg;
	if (!workflowId) {
		deps.sendTo(ws, { type: "error", message: "Missing workflowId" });
		return;
	}
	const workflow = await loadWorkflowForArchive(workflowId, deps);
	if (!workflow) {
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId,
			epicId: null,
			reason: "not-found",
			message: "Workflow not found.",
		});
		return;
	}
	if (workflow.epicId !== null) {
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId,
			epicId: workflow.epicId,
			reason: "child-spec-independent-archive",
			message: "Child specs of an epic can only be archived by archiving the epic.",
		});
		return;
	}
	if (workflow.archived) {
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId,
			epicId: null,
			reason: "already-archived",
			message: "Workflow is already archived.",
		});
		return;
	}
	if (workflow.status === "running") {
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId,
			epicId: null,
			reason: "not-archivable-state",
			message: "Cannot archive a workflow while it is running.",
		});
		return;
	}
	const archivedAt = new Date().toISOString();
	try {
		await persistArchiveFlip(workflow, { archived: true, archivedAt, updatedAt: archivedAt }, deps);
	} catch (err) {
		logger.error(`[ws] workflow:archive persist failed: ${err}`);
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId,
			epicId: null,
			reason: "persist-failed",
			message: "Could not persist archive — please retry.",
		});
		return;
	}
	deps.sharedAuditLogger.logArchiveEvent({
		eventType: "workflow.archive",
		pipelineName: workflow.featureBranch ?? workflow.worktreeBranch ?? workflow.id,
		workflowId: workflow.id,
		epicId: workflow.epicId,
	});
	deps.broadcast({ type: "workflow:state", workflow: deps.stripInternalFields(workflow) });
};

export const handleUnarchiveWorkflow: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "workflow:unarchive" };
	const { workflowId } = msg;
	if (!workflowId) {
		deps.sendTo(ws, { type: "error", message: "Missing workflowId" });
		return;
	}
	const workflow = await loadWorkflowForArchive(workflowId, deps);
	if (!workflow) {
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId,
			epicId: null,
			reason: "not-found",
			message: "Workflow not found.",
		});
		return;
	}
	if (workflow.epicId !== null) {
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId,
			epicId: workflow.epicId,
			reason: "child-spec-independent-archive",
			message: "Child specs of an epic can only be unarchived by unarchiving the epic.",
		});
		return;
	}
	if (!workflow.archived) {
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId,
			epicId: null,
			reason: "already-active",
			message: "Workflow is not archived.",
		});
		return;
	}
	try {
		await persistArchiveFlip(
			workflow,
			{
				archived: false,
				archivedAt: null,
				updatedAt: new Date().toISOString(),
				autoArchiveExempt: true,
			},
			deps,
		);
	} catch (err) {
		logger.error(`[ws] workflow:unarchive persist failed: ${err}`);
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId,
			epicId: null,
			reason: "persist-failed",
			message: "Could not persist unarchive — please retry.",
		});
		return;
	}
	deps.sharedAuditLogger.logArchiveEvent({
		eventType: "workflow.unarchive",
		pipelineName: workflow.featureBranch ?? workflow.worktreeBranch ?? workflow.id,
		workflowId: workflow.id,
		epicId: workflow.epicId,
	});
	deps.broadcast({ type: "workflow:state", workflow: deps.stripInternalFields(workflow) });
};

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
