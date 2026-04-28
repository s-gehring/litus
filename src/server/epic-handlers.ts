import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { AsyncLock } from "../async-lock";
import { analyzeEpic, UnrecoverableSessionError } from "../epic-analyzer";
import { computeEligibleFirstLevelSpecs } from "../epic-eligibility";
import { toErrorMessage } from "../errors";
import { logger } from "../logger";
import type {
	ClientMessage,
	EpicFeedbackEntry,
	PersistedEpic,
	ServerMessage,
	Workflow,
} from "../types";
import { EPIC_FEEDBACK_MAX_LENGTH } from "../types";
import { createEpicWorkflows } from "../workflow-engine";
import type { HandlerDeps, MessageHandler, WsData } from "./handler-types";
import { resolveTargetRepo, validateTextInput } from "./handler-types";

function buildEpicData(
	fields: Pick<PersistedEpic, "epicId" | "description" | "status" | "title" | "workflowIds"> & {
		analysisStartedAt: number;
		infeasibleNotes: string | null;
		summary: string | null;
		decompositionSessionId?: string | null;
		feedbackHistory?: PersistedEpic["feedbackHistory"];
		sessionContextLost?: boolean;
		attemptCount?: number;
	},
): PersistedEpic {
	return {
		epicId: fields.epicId,
		description: fields.description,
		status: fields.status,
		title: fields.title,
		workflowIds: fields.workflowIds,
		startedAt: new Date(fields.analysisStartedAt).toISOString(),
		completedAt: new Date().toISOString(),
		errorMessage: null,
		infeasibleNotes: fields.infeasibleNotes,
		analysisSummary: fields.summary,
		decompositionSessionId: fields.decompositionSessionId ?? null,
		feedbackHistory: fields.feedbackHistory ?? [],
		sessionContextLost: fields.sessionContextLost ?? false,
		attemptCount: fields.attemptCount ?? 1,
		archived: false,
		archivedAt: null,
	};
}

export const handleEpicStart: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "epic:start" };
	const { description, targetRepository, autoStart, submissionId } = msg;

	const inputError = validateTextInput(description, "Epic description", { minLength: 10 });
	if (inputError) {
		deps.sendTo(ws, { type: "error", message: inputError });
		return;
	}

	const resolved = await resolveTargetRepo(targetRepository, submissionId, ws, deps);
	if (!resolved) return;
	const repoDir = resolved.path;

	let committed = false;
	const epicId = randomUUID();
	const trimmedDesc = description.trim();
	const analysisStartedAt = Date.now();
	logger.info(`[epic] Starting analysis (${epicId.slice(0, 8)}): "${trimmedDesc.slice(0, 80)}"`);

	deps.broadcast({ type: "epic:created", epicId, description: trimmedDesc });

	// Generate summary async (non-blocking)
	deps.sharedSummarizer
		.generateSpecSummary(trimmedDesc)
		.then(({ summary }) => {
			if (summary) {
				deps.broadcast({ type: "epic:summary", epicId, summary });
			}
		})
		.catch((err) => {
			logger.warn(`[epic] Summary generation failed: ${err}`);
		});

	let capturedSessionId: string | null = null;
	try {
		const result = await analyzeEpic(trimmedDesc, repoDir, deps.epicAnalysisRef, undefined, {
			onOutput: (text) => deps.emitText({ kind: "epic", epicId }, text),
			onTools: (tools) => deps.broadcast({ type: "epic:tools", epicId, tools }),
			onSessionId: (sid) => {
				capturedSessionId = sid;
			},
		});

		const analysisMs = Date.now() - analysisStartedAt;
		logger.info(`[epic] Analysis complete (${epicId.slice(0, 8)}): ${result.specs.length} specs`);

		// Handle infeasible epic (empty specs with infeasibleNotes)
		if (result.specs.length === 0 && result.infeasibleNotes) {
			logger.info(
				`[epic] Infeasible (${epicId.slice(0, 8)}): ${result.infeasibleNotes.slice(0, 80)}`,
			);
			const epicData = buildEpicData({
				epicId,
				description: trimmedDesc,
				status: "infeasible",
				title: result.title,
				workflowIds: [],
				analysisStartedAt,
				infeasibleNotes: result.infeasibleNotes,
				summary: result.summary,
				decompositionSessionId: capturedSessionId,
			});
			await deps.sharedEpicStore.save(epicData);
			deps.broadcast({
				type: "epic:infeasible",
				epicId,
				title: result.title,
				infeasibleNotes: result.infeasibleNotes,
			});
			// Infeasible: no child workflows will own the clone. Set committed so
			// the `finally` release runs exactly once (here) — a second call would
			// noop in the real store but still logs a call in tests and paints the
			// intent less clearly.
			if (resolved.managedRepo) {
				await deps.managedRepoStore
					.release(resolved.managedRepo.owner, resolved.managedRepo.repo)
					.catch((relErr) => logger.warn(`[epic] infeasible release failed: ${relErr}`));
			}
			committed = true;
			return;
		}

		const { workflows } = await createEpicWorkflows(result, repoDir, epicId, resolved.managedRepo);

		// Defensive guard: if the analyzer produced zero specs without flagging
		// the epic as infeasible (malformed JSON, future no-op code path, etc.),
		// no child workflow will own the initial acquire. Leave `committed` false
		// so the `finally` below drops the refcount.
		if (workflows.length === 0) {
			logger.warn(
				`[epic] ${epicId.slice(0, 8)} produced 0 workflows without infeasibleNotes — releasing clone`,
			);
			deps.broadcast({
				type: "epic:result",
				epicId,
				title: result.title,
				specCount: 0,
				workflowIds: [],
				summary: result.summary,
			});
			return;
		}

		// Store the analysis duration on the first child workflow
		workflows[0].epicAnalysisMs = analysisMs;

		const workflowIds: string[] = [];

		// Persist and register orchestrators for each workflow.
		//
		// Bump the managed-repo refCount BEFORE save, per iteration, rather than
		// once up front by (N-1). A mid-loop save failure then leaves the on-disk
		// refCount equal to the number of successfully persisted workflows: the
		// `finally` below releases the initial acquire (which covered this failing
		// iteration's bump), and each persisted workflow later releases via its
		// orchestrator. Up-front bumping was the cause of review-4 finding #1.
		for (let i = 0; i < workflows.length; i++) {
			const workflow = workflows[i];
			if (i > 0 && resolved.managedRepo) {
				await deps.managedRepoStore.bumpRefCount(
					resolved.managedRepo.owner,
					resolved.managedRepo.repo,
					1,
				);
			}
			await deps.sharedStore.save(workflow);

			const orch = deps.createOrchestrator();
			orch.getEngine().setWorkflow(workflow);
			deps.orchestrators.set(workflow.id, orch);

			deps.broadcast({ type: "workflow:created", workflow: deps.stripInternalFields(workflow) });
			workflowIds.push(workflow.id);

			// Auto-start independent specs when autoStart is true
			if (autoStart && workflow.epicDependencyStatus === "satisfied") {
				orch.startPipelineFromWorkflow(workflow);
			}
		}

		const epicData = buildEpicData({
			epicId,
			description: trimmedDesc,
			status: "completed",
			title: result.title,
			workflowIds,
			analysisStartedAt,
			infeasibleNotes: result.infeasibleNotes,
			summary: result.summary,
		});
		await deps.sharedEpicStore.save(epicData);

		deps.broadcast({
			type: "epic:result",
			epicId,
			title: result.title,
			specCount: result.specs.length,
			workflowIds,
			summary: result.summary,
		});
		committed = true;
	} catch (err) {
		const message = toErrorMessage(err);
		logger.error(`[epic] Analysis failed (${epicId.slice(0, 8)}): ${message}`);
		if (err instanceof Error && err.stack) {
			logger.error(`[epic] Stack trace: ${err.stack}`);
		}
		// Persist a minimal epic record so the user can retry via feedback.
		// Without this save, `handleEpicFeedback` rejects with
		// validation/"Unknown epic" (research.md R1).
		try {
			const errorRecord: PersistedEpic = {
				epicId,
				description: trimmedDesc,
				status: "error",
				title: null,
				workflowIds: [],
				startedAt: new Date(analysisStartedAt).toISOString(),
				completedAt: new Date().toISOString(),
				errorMessage: message,
				infeasibleNotes: null,
				analysisSummary: null,
				decompositionSessionId: capturedSessionId,
				feedbackHistory: [],
				sessionContextLost: false,
				attemptCount: 1,
				archived: false,
				archivedAt: null,
			};
			await deps.sharedEpicStore.save(errorRecord);
		} catch (saveErr) {
			logger.warn(`[epic] Failed to persist error record: ${saveErr}`);
		}
		deps.broadcast({ type: "epic:error", epicId, message });
	} finally {
		// If we failed before the workflows took ownership of the clone, release
		// the initial acquire so the clone is cleaned up.
		if (!committed && resolved.managedRepo) {
			await deps.managedRepoStore
				.release(resolved.managedRepo.owner, resolved.managedRepo.repo)
				.catch((relErr) => {
					logger.warn(`[epic] managed-repo release after failed epic:start: ${relErr}`);
				});
		}
	}
};

export const handleEpicAbort: MessageHandler = (_ws, _data, deps) => {
	if (deps.epicAnalysisRef.current) {
		deps.epicAnalysisRef.current.kill();
		deps.epicAnalysisRef.current = null;
	}
};

// ── Epic feedback ─────────────────────────────────────────

// Per-epic serialization of feedback submissions. A held lock surfaces as an
// `in_flight` rejection rather than queueing, per FR-010.
const feedbackLocks = new Map<string, AsyncLock>();

function getFeedbackLock(epicId: string): AsyncLock {
	let lock = feedbackLocks.get(epicId);
	if (!lock) {
		lock = new AsyncLock();
		feedbackLocks.set(epicId, lock);
	}
	return lock;
}

async function findChildWorkflowsOfEpic(
	epic: PersistedEpic,
	deps: HandlerDeps,
): Promise<Workflow[]> {
	const results: Workflow[] = [];
	for (const wfId of epic.workflowIds) {
		const orch = deps.orchestrators.get(wfId);
		const fromOrch = orch?.getEngine().getWorkflow() ?? null;
		if (fromOrch) {
			results.push(fromOrch);
			continue;
		}
		const loaded = await deps.sharedStore.load(wfId);
		if (loaded) results.push(loaded);
	}
	return results;
}

async function deleteChildWorkflows(
	epic: PersistedEpic,
	deps: HandlerDeps,
	opts: { suppressEpicFinishedAlert?: boolean } = {},
): Promise<void> {
	for (const wfId of epic.workflowIds) {
		const orch = deps.orchestrators.get(wfId);
		if (orch) {
			try {
				orch.abortPipeline(wfId, opts);
			} catch (err) {
				logger.warn(`[epic-feedback] abort orchestrator ${wfId} failed: ${err}`);
			}
			deps.orchestrators.delete(wfId);
		}
		let removed = true;
		try {
			await deps.sharedStore.remove(wfId);
		} catch (err) {
			removed = false;
			logger.warn(`[epic-feedback] remove workflow ${wfId} failed: ${err}`);
		}
		if (removed) {
			deps.broadcast({ type: "workflow:removed", workflowId: wfId });
		}
	}
}

type FeedbackRejectReasonCode = Extract<
	ServerMessage,
	{ type: "epic:feedback:rejected" }
>["reasonCode"];

function sendReject(
	ws: ServerWebSocket<WsData>,
	deps: HandlerDeps,
	epicId: string,
	reasonCode: FeedbackRejectReasonCode,
	reason: string,
): void {
	deps.sendTo(ws, { type: "epic:feedback:rejected", epicId, reasonCode, reason });
}

export const handleEpicFeedback: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "epic:feedback" };
	const epicId = msg.epicId;
	const rawText = typeof msg.text === "string" ? msg.text : "";

	// 1. Validation errors (text first, then epicId lookup). Centralise via
	// `validateTextInput` per T013 — it enforces trim+min+max and composes the
	// uniform error message shape.
	const textError = validateTextInput(rawText, "Feedback", {
		minLength: 1,
		maxLength: EPIC_FEEDBACK_MAX_LENGTH,
		emptyMessage: "Feedback is empty.",
		overLimitMessage: `Feedback exceeds ${EPIC_FEEDBACK_MAX_LENGTH} characters.`,
	});
	if (textError) {
		sendReject(ws, deps, epicId, "validation", textError);
		return;
	}
	const trimmed = rawText.trim();

	const epics = await deps.sharedEpicStore.loadAll();
	const epic = epics.find((e) => e.epicId === epicId);
	if (!epic) {
		sendReject(ws, deps, epicId, "validation", "Unknown epic.");
		return;
	}

	// 2. spec_started check
	const childWorkflows = await findChildWorkflowsOfEpic(epic, deps);
	if (childWorkflows.some((w) => w.hasEverStarted)) {
		sendReject(ws, deps, epicId, "spec_started", "A child spec has already started.");
		return;
	}

	// 3. in_flight — tryRun returns null if lock held
	const lock = getFeedbackLock(epicId);
	const runPromise = lock.tryRun(async () => {
		// Re-check spec_started inside the lock. Between the earlier
		// findChildWorkflowsOfEpic await and this point, a
		// workflow:start-existing / force-start could have flipped
		// `hasEverStarted` (the event loop can interleave). Serializing the
		// check here closes that check-then-act race.
		const freshChildren = await findChildWorkflowsOfEpic(epic, deps);
		if (freshChildren.some((w) => w.hasEverStarted)) {
			sendReject(ws, deps, epicId, "spec_started", "A child spec has already started.");
			return;
		}
		await runFeedbackAttempt(epic, trimmed, deps);
	});
	if (runPromise === null) {
		sendReject(ws, deps, epicId, "in_flight", "Another decomposition attempt is already running.");
		return;
	}

	try {
		await runPromise;
	} catch (err) {
		logger.error(`[epic-feedback] run failed (${epicId.slice(0, 8)}): ${toErrorMessage(err)}`);
		deps.broadcast({
			type: "epic:error",
			epicId,
			message: toErrorMessage(err),
		});
	} finally {
		// Drop the lock entry if the epic is permanently ineligible for further
		// feedback (any child has started). Prevents feedbackLocks from growing
		// unboundedly over a long-running server. Safe because no further
		// submission can acquire this lock — new ones would be rejected with
		// spec_started before reaching getFeedbackLock anyway.
		try {
			const laterChildren = await findChildWorkflowsOfEpic(epic, deps);
			if (laterChildren.some((w) => w.hasEverStarted)) {
				feedbackLocks.delete(epicId);
			}
		} catch (err) {
			// Non-fatal; leave the lock and retry on next submission. Log at
			// debug so an operator seeing repeated lock retention has a
			// breadcrumb if this path starts failing (e.g. corrupted workflow
			// file on disk) without adding pager noise.
			logger.warn(`[epic-feedback] lock cleanup check failed for ${epicId.slice(0, 8)}: ${err}`);
		}
	}
};

async function runFeedbackAttempt(
	initialEpic: PersistedEpic,
	trimmedText: string,
	deps: HandlerDeps,
): Promise<void> {
	// Reload latest epic state inside the lock for a fresh copy. Inside the
	// feedback lock, `initialEpic` and the reloaded `epic` should have identical
	// `workflowIds` (the lock serialises feedback; handleEpicStart can't be
	// running concurrently because the epic is already persisted). The reload
	// is defensive — use `epic` for all subsequent reads/writes, `initialEpic`
	// only for the look-up below.
	let epics = await deps.sharedEpicStore.loadAll();
	let epic = epics.find((e) => e.epicId === initialEpic.epicId) ?? initialEpic;
	const epicId = epic.epicId;

	const entry: EpicFeedbackEntry = {
		id: randomUUID(),
		text: trimmedText,
		submittedAt: new Date().toISOString(),
		attemptSessionId: null,
		contextLostOnThisAttempt: false,
		outcome: null,
	};

	// Resolve the repoDir and inherited managedRepo BEFORE aborting the prior
	// workflows. If the epic was created from a GitHub URL, every child has
	// `managedRepo = {owner, repo}` and the per-workflow `releaseManagedRepoIfAny`
	// fired inside `deleteChildWorkflows → abortPipeline` would decrement the
	// refcount to 0 and delete the clone mid-flight, racing the upcoming
	// `analyzeEpic` call. We hold one extra refcount across the abort loop so
	// the clone survives, then hand that refcount to the new workflows.
	let repoDir: string | null = null;
	let inheritedManagedRepo: Workflow["managedRepo"] = null;
	for (const wfId of initialEpic.workflowIds) {
		const loaded = await deps.sharedStore.load(wfId);
		if (loaded) {
			if (!repoDir && loaded.targetRepository) repoDir = loaded.targetRepository;
			if (!inheritedManagedRepo && loaded.managedRepo) inheritedManagedRepo = loaded.managedRepo;
		}
		if (repoDir && inheritedManagedRepo) break;
	}

	// Hold a protective +1 refcount so the clone isn't deleted by the
	// abort-induced releases. Balanced either by the first new workflow
	// inheriting the ref (no extra bump) or by an explicit release in the
	// error path below.
	let heldManagedRef = false;
	if (inheritedManagedRepo) {
		await deps.managedRepoStore.bumpRefCount(
			inheritedManagedRepo.owner,
			inheritedManagedRepo.repo,
			1,
		);
		heldManagedRef = true;
	}

	const releaseHeldRefIfAny = async (): Promise<void> => {
		if (heldManagedRef && inheritedManagedRepo) {
			heldManagedRef = false;
			await deps.managedRepoStore
				.release(inheritedManagedRepo.owner, inheritedManagedRepo.repo)
				.catch((err) =>
					logger.warn(`[epic-feedback] managed-repo release after failed attempt: ${err}`),
				);
		}
	};

	// Delete prior child workflows BEFORE persisting the new epic state. Doing
	// this in reverse (save → delete) leaves a window where a crash between
	// steps orphans the workflow files on disk: the new epic would have
	// `workflowIds: []`, so a recovery pass can't find them to clean up. By
	// deleting first, `epic.workflowIds` on disk still references the
	// (possibly incomplete) prior set until save completes, and
	// `deleteChildWorkflows` is idempotent per-ID — a retry after a crash
	// picks up any survivors via the same loop over `initialEpic.workflowIds`.
	// Suppress `epic-finished`: the cascade aborts already-terminal siblings,
	// which would otherwise re-trigger the alert mid-feedback (FR-001).
	await deleteChildWorkflows(initialEpic, deps, { suppressEpicFinishedAlert: true });

	epic = {
		...epic,
		feedbackHistory: [...epic.feedbackHistory, entry],
		attemptCount: epic.attemptCount + 1,
		// Clear prior terminal annotations when accepting feedback on infeasible/error.
		infeasibleNotes: epic.status === "infeasible" ? null : epic.infeasibleNotes,
		errorMessage: epic.status === "error" ? null : epic.errorMessage,
		status: "analyzing",
		workflowIds: [],
		// Reset the timer for the new attempt so idle time between the prior
		// completion and this feedback submission isn't billed to the analysis.
		startedAt: new Date().toISOString(),
		completedAt: null,
	};

	await deps.sharedEpicStore.save(epic);

	deps.sharedAuditLogger.logFeedbackSubmitted({
		epicId,
		feedbackEntryId: entry.id,
		textLength: trimmedText.length,
		sessionContextLost: epic.sessionContextLost,
	});

	deps.broadcast({ type: "epic:feedback:accepted", epicId, entry });
	deps.broadcast({
		type: "epic:feedback:history",
		epicId,
		entries: epic.feedbackHistory,
		sessionContextLost: epic.sessionContextLost,
	});

	// Drives the three terminal-error branches (no repoDir, analyze-failed,
	// fresh-fallback-failed) through one persist+broadcast path.
	const failAttempt = async (message: string): Promise<void> => {
		entry.outcome = "error";
		const latest = await deps.sharedEpicStore.loadAll();
		const current = latest.find((e) => e.epicId === epicId) ?? epic;
		const updated: PersistedEpic = {
			...current,
			status: "error",
			errorMessage: message,
			completedAt: new Date().toISOString(),
			feedbackHistory: current.feedbackHistory.map((e) => (e.id === entry.id ? entry : e)),
		};
		await deps.sharedEpicStore.save(updated);
		epic = updated;
		deps.broadcast({
			type: "epic:feedback:history",
			epicId,
			entries: updated.feedbackHistory,
			sessionContextLost: updated.sessionContextLost,
		});
		deps.broadcast({ type: "epic:error", epicId, message });
		await releaseHeldRefIfAny();
	};

	if (!repoDir) {
		await failAttempt("No target repository available for feedback attempt.");
		return;
	}

	let capturedSessionId: string | null = null;
	const resumeSessionId = epic.decompositionSessionId;
	// Only audit `decomposition_resumed` when we actually have a session id to
	// resume. Without one, the first attempt errored before capturing a
	// session — no resume is possible, and the audit record would carry a
	// misleading `sessionId: null`.
	if (resumeSessionId) {
		deps.sharedAuditLogger.logDecompositionResumed({
			epicId,
			sessionId: resumeSessionId,
			attemptReason: "feedback",
		});
	}

	let contextLost = false;
	let result: Awaited<ReturnType<typeof analyzeEpic>>;
	try {
		result = await analyzeEpic(
			epic.description,
			repoDir,
			deps.epicAnalysisRef,
			undefined,
			{
				onOutput: (text) => deps.emitText({ kind: "epic", epicId }, text),
				onTools: (tools) => deps.broadcast({ type: "epic:tools", epicId, tools }),
				onSessionId: (sid) => {
					capturedSessionId = sid;
				},
			},
			resumeSessionId,
		);
	} catch (err) {
		if (err instanceof UnrecoverableSessionError && resumeSessionId) {
			contextLost = true;
			entry.contextLostOnThisAttempt = true;
			capturedSessionId = null;
			// Rebuild prompt per FR-015: the original epic description plus
			// every feedback entry's text. Sections are labelled so the LLM
			// can tell the original ask from successive user corrections;
			// without labels, references like "split spec 2" in later
			// entries read as part of the original prompt.
			const feedbackBlock = epic.feedbackHistory.map((e, i) => `${i + 1}. ${e.text}`).join("\n\n");
			const combined = `Original epic:\n${epic.description}\n\nUser feedback (oldest first):\n${feedbackBlock}`;
			epic = {
				...epic,
				decompositionSessionId: null,
				sessionContextLost: true,
				feedbackHistory: epic.feedbackHistory.map((e) => (e.id === entry.id ? entry : e)),
			};
			await deps.sharedEpicStore.save(epic);
			deps.broadcast({
				type: "epic:feedback:history",
				epicId,
				entries: epic.feedbackHistory,
				sessionContextLost: epic.sessionContextLost,
			});
			try {
				result = await analyzeEpic(combined, repoDir, deps.epicAnalysisRef, undefined, {
					onOutput: (text) => deps.emitText({ kind: "epic", epicId }, text),
					onTools: (tools) => deps.broadcast({ type: "epic:tools", epicId, tools }),
					onSessionId: (sid) => {
						capturedSessionId = sid;
					},
				});
				// Record the fresh-fallback attempt under its NEW session id so the
				// audit trail shows "resumed X → failed → fresh with Y" instead of
				// stopping at the resume-failed record.
				if (capturedSessionId) {
					deps.sharedAuditLogger.logDecompositionResumed({
						epicId,
						sessionId: capturedSessionId,
						attemptReason: "feedback",
					});
				}
			} catch (err2) {
				// Fresh fallback also failed. The earlier branch already set
				// `sessionContextLost = true` on the epic; leave it sticky. A
				// subsequent successful attempt or an explicit ack clears it.
				await failAttempt(toErrorMessage(err2));
				return;
			}
		} else {
			await failAttempt(toErrorMessage(err));
			return;
		}
	}

	entry.attemptSessionId = capturedSessionId;

	// Re-load current epic (persistence may have changed during streaming) and
	// merge back our session id + entry outcome.
	epics = await deps.sharedEpicStore.loadAll();
	const persistedNow = epics.find((e) => e.epicId === epicId) ?? epic;

	// Infeasible path
	if (result.specs.length === 0 && result.infeasibleNotes) {
		entry.outcome = "infeasible";
		epic = {
			...persistedNow,
			status: "infeasible",
			title: result.title,
			infeasibleNotes: result.infeasibleNotes,
			analysisSummary: result.summary,
			workflowIds: [],
			completedAt: new Date().toISOString(),
			decompositionSessionId: capturedSessionId ?? persistedNow.decompositionSessionId,
			sessionContextLost: contextLost ? true : persistedNow.sessionContextLost,
			feedbackHistory: persistedNow.feedbackHistory.map((e) => (e.id === entry.id ? entry : e)),
		};
		await deps.sharedEpicStore.save(epic);
		deps.broadcast({
			type: "epic:feedback:history",
			epicId,
			entries: epic.feedbackHistory,
			sessionContextLost: epic.sessionContextLost,
		});
		deps.broadcast({
			type: "epic:infeasible",
			epicId,
			title: result.title,
			infeasibleNotes: result.infeasibleNotes,
		});
		// No child workflows will own the held ref; drop it so the clone can
		// be cleaned up by its last remaining consumer (now none).
		await releaseHeldRefIfAny();
		return;
	}

	// Defensive: analyzer returned zero specs AND no infeasibleNotes. Parity
	// with handleEpicStart's same guard — mark completed with empty children
	// rather than silently falling through to the workflow-creation loop.
	if (result.specs.length === 0) {
		logger.warn(
			`[epic] ${epicId.slice(0, 8)} feedback produced 0 workflows without infeasibleNotes — releasing clone`,
		);
		entry.outcome = "completed";
		epic = {
			...persistedNow,
			status: "completed",
			title: result.title,
			workflowIds: [],
			analysisSummary: result.summary,
			infeasibleNotes: null,
			errorMessage: null,
			completedAt: new Date().toISOString(),
			decompositionSessionId: capturedSessionId ?? persistedNow.decompositionSessionId,
			sessionContextLost: contextLost ? true : persistedNow.sessionContextLost,
			feedbackHistory: persistedNow.feedbackHistory.map((e) => (e.id === entry.id ? entry : e)),
		};
		await deps.sharedEpicStore.save(epic);
		deps.broadcast({
			type: "epic:feedback:history",
			epicId,
			entries: epic.feedbackHistory,
			sessionContextLost: epic.sessionContextLost,
		});
		deps.broadcast({
			type: "epic:result",
			epicId,
			title: result.title,
			specCount: 0,
			workflowIds: [],
			summary: result.summary,
		});
		await releaseHeldRefIfAny();
		return;
	}

	// Create new child workflows, inheriting the managed-repo (if any) so they
	// own the clone's refcount. The first workflow absorbs the protective +1
	// we held across the abort loop (so we skip an explicit release); each
	// subsequent workflow bumps by 1, mirroring `handleEpicStart`'s arithmetic.
	const { workflows } = await createEpicWorkflows(result, repoDir, epicId, inheritedManagedRepo);
	const workflowIds: string[] = [];
	for (let i = 0; i < workflows.length; i++) {
		const workflow = workflows[i];
		if (i > 0 && inheritedManagedRepo) {
			await deps.managedRepoStore.bumpRefCount(
				inheritedManagedRepo.owner,
				inheritedManagedRepo.repo,
				1,
			);
		}
		await deps.sharedStore.save(workflow);
		const orch = deps.createOrchestrator();
		orch.getEngine().setWorkflow(workflow);
		deps.orchestrators.set(workflow.id, orch);
		deps.broadcast({
			type: "workflow:created",
			workflow: deps.stripInternalFields(workflow),
		});
		workflowIds.push(workflow.id);
	}
	// The first new workflow adopted the held refcount.
	heldManagedRef = false;

	entry.outcome = "completed";
	epic = {
		...persistedNow,
		status: "completed",
		title: result.title,
		workflowIds,
		analysisSummary: result.summary,
		infeasibleNotes: null,
		errorMessage: null,
		completedAt: new Date().toISOString(),
		decompositionSessionId: capturedSessionId ?? persistedNow.decompositionSessionId,
		sessionContextLost: contextLost ? true : persistedNow.sessionContextLost,
		feedbackHistory: persistedNow.feedbackHistory.map((e) => (e.id === entry.id ? entry : e)),
	};
	await deps.sharedEpicStore.save(epic);

	deps.broadcast({
		type: "epic:feedback:history",
		epicId,
		entries: epic.feedbackHistory,
		sessionContextLost: epic.sessionContextLost,
	});
	deps.broadcast({
		type: "epic:result",
		epicId,
		title: result.title,
		specCount: result.specs.length,
		workflowIds,
		summary: result.summary,
	});
}

export const handleEpicFeedbackAckContextLost: MessageHandler = async (_ws, data, deps) => {
	const msg = data as ClientMessage & { type: "epic:feedback:ack-context-lost" };
	const epicId = msg.epicId;
	const epics = await deps.sharedEpicStore.loadAll();
	const epic = epics.find((e) => e.epicId === epicId);
	if (!epic) return;
	if (!epic.sessionContextLost) {
		// Idempotent: still broadcast current state.
		deps.broadcast({
			type: "epic:feedback:history",
			epicId,
			entries: epic.feedbackHistory,
			sessionContextLost: epic.sessionContextLost,
		});
		return;
	}
	const updated: PersistedEpic = { ...epic, sessionContextLost: false };
	await deps.sharedEpicStore.save(updated);
	deps.broadcast({
		type: "epic:feedback:history",
		epicId,
		entries: updated.feedbackHistory,
		sessionContextLost: false,
	});
};

export const handleEpicStartFirstLevel: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "epic:start-first-level" };
	const { epicId } = msg;
	if (!epicId || typeof epicId !== "string") {
		logger.error(`[ws] epic:start-first-level rejected: missing epicId`);
		deps.sendTo(ws, { type: "error", message: "epicId is required" });
		return;
	}

	// Resolve each workflow via loadLiveOrPersisted so the orchestrator's
	// in-memory state wins over the (possibly stale) on-disk snapshot. Passing
	// the live reference into startPipelineFromWorkflow also avoids overwriting
	// unpersisted in-memory mutations via setWorkflow().
	const persisted = await deps.sharedStore.loadAll();
	const epicWorkflowIds = persisted.filter((wf) => wf.epicId === epicId).map((wf) => wf.id);
	const epicWorkflows: import("../types").Workflow[] = [];
	for (const id of epicWorkflowIds) {
		const live = await loadLiveOrPersisted(deps, id);
		if (live) epicWorkflows.push(live);
	}
	const eligible = computeEligibleFirstLevelSpecs(epicId, epicWorkflows);
	const eligibleIds = new Set(eligible.map((e) => e.workflowId));
	const skipped = epicWorkflows.filter((wf) => !eligibleIds.has(wf.id)).map((wf) => wf.id);

	const started: string[] = [];
	const failed: { workflowId: string; message: string }[] = [];
	const results = await Promise.allSettled(
		eligible.map(({ workflowId }) => {
			const wf = epicWorkflows.find((w) => w.id === workflowId) as import("../types").Workflow;
			return Promise.resolve().then(() => {
				const orch = deps.orchestrators.get(workflowId);
				if (!orch) {
					throw new Error(`Orchestrator for workflow ${workflowId} not registered`);
				}
				orch.startPipelineFromWorkflow(wf);
				return workflowId;
			});
		}),
	);
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const workflowId = eligible[i].workflowId;
		if (r.status === "fulfilled") {
			started.push(workflowId);
		} else {
			failed.push({ workflowId, message: toErrorMessage(r.reason) });
		}
	}

	deps.sendTo(ws, {
		type: "epic:start-first-level:result",
		epicId,
		started,
		skipped,
		failed,
	});
};

type EpicBatchKind = "pause-all" | "resume-all" | "abort-all";

/**
 * Fan-out helper for the epic-level batch controls. Resolves every child
 * workflow of the epic and applies the per-workflow control whose status
 * predicate accepts it. Best-effort: a child whose status doesn't admit the
 * control is silently skipped — the user gets the same per-workflow guard
 * as if they'd clicked the button on each child individually.
 */
async function applyEpicBatchControl(
	ws: ServerWebSocket<WsData>,
	epicId: string,
	kind: EpicBatchKind,
	deps: HandlerDeps,
): Promise<void> {
	if (!epicId || typeof epicId !== "string") {
		logger.error(`[ws] epic:${kind} rejected: missing epicId`);
		deps.sendTo(ws, { type: "error", message: "epicId is required" });
		return;
	}
	const persisted = await deps.sharedStore.loadAll();
	// Skip archived children explicitly. In practice archived workflows
	// shed their orchestrator on archive, but the explicit filter prevents
	// any future change to that contract from accidentally fanning out
	// pause/resume/abort to archived rows.
	const childIds = persisted
		.filter((wf) => wf.epicId === epicId && wf.archived !== true)
		.map((wf) => wf.id);
	// Resolve live-or-persisted states in parallel — most lookups are
	// in-memory cache hits but a fall-through to disk shouldn't serialize.
	const lives = await Promise.all(childIds.map((id) => loadLiveOrPersisted(deps, id)));
	for (let i = 0; i < childIds.length; i++) {
		const wfId = childIds[i];
		const live = lives[i];
		if (!wfId || !live) continue;
		const orch = deps.orchestrators.get(wfId);
		if (!orch) continue;
		// Per-child error isolation: a single failing orchestrator must not
		// strand the rest of the fan-out. Mirror the semantics of
		// handleEpicStartFirstLevel which uses Promise.allSettled.
		try {
			switch (kind) {
				case "pause-all":
					if (live.status === "running") orch.pause(wfId);
					break;
				case "resume-all":
					if (live.status === "paused") orch.resume(wfId);
					break;
				case "abort-all":
					// Mirror handleAbort's predicate: only non-terminal, non-running
					// statuses admit abort. Running workflows must be paused first.
					if (
						live.status === "paused" ||
						live.status === "waiting_for_input" ||
						live.status === "waiting_for_dependencies" ||
						live.status === "error"
					) {
						orch.abortPipeline(wfId);
						deps.orchestrators.delete(wfId);
					}
					break;
			}
		} catch (err) {
			logger.warn(`[ws] epic:${kind} on ${wfId} failed: ${toErrorMessage(err)}`);
		}
	}
}

export const handleEpicPauseAll: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "epic:pause-all" };
	await applyEpicBatchControl(ws, msg.epicId, "pause-all", deps);
};

export const handleEpicResumeAll: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "epic:resume-all" };
	await applyEpicBatchControl(ws, msg.epicId, "resume-all", deps);
};

export const handleEpicAbortAll: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "epic:abort-all" };
	await applyEpicBatchControl(ws, msg.epicId, "abort-all", deps);
};

// ── Archive / Unarchive (cascade) ─────────────────────────

async function loadLiveOrPersisted(deps: Parameters<MessageHandler>[2], id: string) {
	const orch = deps.orchestrators.get(id);
	const live = orch?.getEngine().getWorkflow();
	if (live) return live;
	return deps.sharedStore.load(id);
}

export const handleArchiveEpic: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "epic:archive" };
	const { epicId } = msg;
	if (!epicId) {
		deps.sendTo(ws, { type: "error", message: "Missing epicId" });
		return;
	}
	const epics = await deps.sharedEpicStore.loadAll();
	const epic = epics.find((e) => e.epicId === epicId);
	if (!epic) {
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId: null,
			epicId,
			reason: "not-found",
			message: "Epic not found.",
		});
		return;
	}
	if (epic.archived) {
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId: null,
			epicId,
			reason: "already-archived",
			message: "Epic is already archived.",
		});
		return;
	}

	const children: import("../types").Workflow[] = [];
	for (const childId of epic.workflowIds) {
		const child = await loadLiveOrPersisted(deps, childId);
		if (child) children.push(child);
	}
	const runningChildren = children.filter((c) => c.status === "running");
	if (runningChildren.length > 0) {
		const names = runningChildren.map((c) => c.summary || c.specification || c.id).join(", ");
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId: runningChildren[0].id,
			epicId,
			reason: "not-archivable-state",
			message: `Cannot archive epic while running: ${names}.`,
		});
		return;
	}

	const archivedAt = new Date().toISOString();
	const affected: import("../types").Workflow[] = [];
	try {
		// Persist epic first, then children (research R-05): a mid-cascade failure
		// leaves an archived epic with possibly-unarchived children — recoverable
		// via retry — rather than orphan archived children under a live epic.
		const epicSnapshot = { archived: epic.archived, archivedAt: epic.archivedAt };
		epic.archived = true;
		epic.archivedAt = archivedAt;
		try {
			await deps.sharedEpicStore.save(epic);
		} catch (err) {
			epic.archived = epicSnapshot.archived;
			epic.archivedAt = epicSnapshot.archivedAt;
			throw err;
		}
		for (const child of children) {
			if (child.archived) continue;
			const snapshot = {
				archived: child.archived,
				archivedAt: child.archivedAt,
				updatedAt: child.updatedAt,
			};
			child.archived = true;
			child.archivedAt = archivedAt;
			child.updatedAt = archivedAt;
			try {
				await deps.sharedStore.save(child);
				affected.push(child);
			} catch (err) {
				child.archived = snapshot.archived;
				child.archivedAt = snapshot.archivedAt;
				child.updatedAt = snapshot.updatedAt;
				throw err;
			}
		}
	} catch (err) {
		logger.error(`[ws] epic:archive persist failed: ${err}`);
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId: null,
			epicId,
			reason: "persist-failed",
			message: "Could not persist epic archive — please retry.",
		});
		return;
	}

	deps.sharedAuditLogger.logArchiveEvent({
		eventType: "epic.archive",
		pipelineName: `epic-${epicId}`,
		workflowId: null,
		epicId,
	});

	deps.broadcast({ type: "epic:list", epics });
	for (const child of affected) {
		deps.broadcast({ type: "workflow:state", workflow: deps.stripInternalFields(child) });
	}
};

export const handleUnarchiveEpic: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "epic:unarchive" };
	const { epicId } = msg;
	if (!epicId) {
		deps.sendTo(ws, { type: "error", message: "Missing epicId" });
		return;
	}
	const epics = await deps.sharedEpicStore.loadAll();
	const epic = epics.find((e) => e.epicId === epicId);
	if (!epic) {
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId: null,
			epicId,
			reason: "not-found",
			message: "Epic not found.",
		});
		return;
	}
	if (!epic.archived) {
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId: null,
			epicId,
			reason: "already-active",
			message: "Epic is not archived.",
		});
		return;
	}

	const affected: import("../types").Workflow[] = [];
	try {
		const epicSnapshot = {
			archived: epic.archived,
			archivedAt: epic.archivedAt,
			autoArchiveExempt: epic.autoArchiveExempt,
		};
		epic.archived = false;
		epic.archivedAt = null;
		epic.autoArchiveExempt = true;
		try {
			await deps.sharedEpicStore.save(epic);
		} catch (err) {
			epic.archived = epicSnapshot.archived;
			epic.archivedAt = epicSnapshot.archivedAt;
			epic.autoArchiveExempt = epicSnapshot.autoArchiveExempt;
			throw err;
		}
		for (const childId of epic.workflowIds) {
			const child = await loadLiveOrPersisted(deps, childId);
			if (!child?.archived) continue;
			const snapshot = {
				archived: child.archived,
				archivedAt: child.archivedAt,
				updatedAt: child.updatedAt,
				autoArchiveExempt: child.autoArchiveExempt,
			};
			child.archived = false;
			child.archivedAt = null;
			child.updatedAt = new Date().toISOString();
			child.autoArchiveExempt = true;
			try {
				await deps.sharedStore.save(child);
				affected.push(child);
			} catch (err) {
				child.archived = snapshot.archived;
				child.archivedAt = snapshot.archivedAt;
				child.updatedAt = snapshot.updatedAt;
				child.autoArchiveExempt = snapshot.autoArchiveExempt;
				throw err;
			}
		}
	} catch (err) {
		logger.error(`[ws] epic:unarchive persist failed: ${err}`);
		deps.sendTo(ws, {
			type: "workflow:archive-denied",
			workflowId: null,
			epicId,
			reason: "persist-failed",
			message: "Could not persist epic unarchive — please retry.",
		});
		return;
	}

	deps.sharedAuditLogger.logArchiveEvent({
		eventType: "epic.unarchive",
		pipelineName: `epic-${epicId}`,
		workflowId: null,
		epicId,
	});

	deps.broadcast({ type: "epic:list", epics });
	for (const child of affected) {
		deps.broadcast({ type: "workflow:state", workflow: deps.stripInternalFields(child) });
	}
};
