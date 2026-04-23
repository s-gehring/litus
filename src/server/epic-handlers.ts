import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { AsyncLock } from "../async-lock";
import { analyzeEpic, UnrecoverableSessionError } from "../epic-analyzer";
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
			onOutput: (text) => deps.broadcast({ type: "epic:output", epicId, text }),
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

async function deleteChildWorkflows(epic: PersistedEpic, deps: HandlerDeps): Promise<void> {
	for (const wfId of epic.workflowIds) {
		const orch = deps.orchestrators.get(wfId);
		if (orch) {
			try {
				orch.abortPipeline(wfId);
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
	epicId: string,
	reasonCode: FeedbackRejectReasonCode,
	reason: string,
	deps: HandlerDeps,
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
		sendReject(ws, epicId, "validation", textError, deps);
		return;
	}
	const trimmed = rawText.trim();

	const epics = await deps.sharedEpicStore.loadAll();
	const epic = epics.find((e) => e.epicId === epicId);
	if (!epic) {
		sendReject(ws, epicId, "validation", "Unknown epic.", deps);
		return;
	}

	// 2. spec_started check
	const childWorkflows = await findChildWorkflowsOfEpic(epic, deps);
	if (childWorkflows.some((w) => w.hasEverStarted)) {
		sendReject(ws, epicId, "spec_started", "A child spec has already started.", deps);
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
			sendReject(ws, epicId, "spec_started", "A child spec has already started.", deps);
			return;
		}
		await runFeedbackAttempt(epic, trimmed, deps);
	});
	if (runPromise === null) {
		sendReject(ws, epicId, "in_flight", "Another decomposition attempt is already running.", deps);
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
		} catch {
			// Non-fatal; leave the lock and retry on next submission.
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

	epic = {
		...epic,
		feedbackHistory: [...epic.feedbackHistory, entry],
		attemptCount: epic.attemptCount + 1,
		// Clear prior terminal annotations when accepting feedback on infeasible/error.
		infeasibleNotes: epic.status === "infeasible" ? null : epic.infeasibleNotes,
		errorMessage: epic.status === "error" ? null : epic.errorMessage,
		status: "analyzing",
		workflowIds: [],
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

	// Delete prior child workflows.
	await deleteChildWorkflows(initialEpic, deps);
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
				onOutput: (text) => deps.broadcast({ type: "epic:output", epicId, text }),
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
			// Rebuild prompt per FR-015: the original epic description followed
			// by every feedback entry's text, joined with double newlines.
			const combined = `${epic.description}\n\n${epic.feedbackHistory.map((e) => e.text).join("\n\n")}`;
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
					onOutput: (text) => deps.broadcast({ type: "epic:output", epicId, text }),
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
