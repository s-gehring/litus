import { randomUUID } from "node:crypto";
import { AsyncLock } from "../async-lock";
import { analyzeEpic, UnrecoverableSessionError } from "../epic-analyzer";
import { toErrorMessage } from "../errors";
import { logger } from "../logger";
import type { ClientMessage, EpicFeedbackEntry, PersistedEpic, Workflow } from "../types";
import { createEpicWorkflows } from "../workflow-engine";
import type { HandlerDeps, MessageHandler } from "./handler-types";
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

const MAX_FEEDBACK_LENGTH = 10_000;

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
		try {
			await deps.sharedStore.remove(wfId);
		} catch (err) {
			logger.warn(`[epic-feedback] remove workflow ${wfId} failed: ${err}`);
		}
		deps.broadcast({ type: "workflow:state", workflow: null });
	}
}

export const handleEpicFeedback: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "epic:feedback" };
	const epicId = msg.epicId;
	const rawText = typeof msg.text === "string" ? msg.text : "";
	const trimmed = rawText.trim();

	// 1. Validation errors (text first, then epicId lookup)
	if (trimmed.length === 0) {
		deps.sendTo(ws, {
			type: "epic:feedback:rejected",
			epicId,
			reasonCode: "validation",
			reason: "Feedback is empty.",
		});
		return;
	}
	if (trimmed.length > MAX_FEEDBACK_LENGTH) {
		deps.sendTo(ws, {
			type: "epic:feedback:rejected",
			epicId,
			reasonCode: "validation",
			reason: `Feedback exceeds ${MAX_FEEDBACK_LENGTH} characters.`,
		});
		return;
	}

	const epics = await deps.sharedEpicStore.loadAll();
	const epic = epics.find((e) => e.epicId === epicId);
	if (!epic) {
		deps.sendTo(ws, {
			type: "epic:feedback:rejected",
			epicId,
			reasonCode: "validation",
			reason: "Unknown epic.",
		});
		return;
	}

	// 2. spec_started check
	const childWorkflows = await findChildWorkflowsOfEpic(epic, deps);
	if (childWorkflows.some((w) => w.hasEverStarted)) {
		deps.sendTo(ws, {
			type: "epic:feedback:rejected",
			epicId,
			reasonCode: "spec_started",
			reason: "A child spec has already started.",
		});
		return;
	}

	// 3. in_flight — tryRun returns null if lock held
	const lock = getFeedbackLock(epicId);
	const runPromise = lock.tryRun(async () => {
		await runFeedbackAttempt(epic, trimmed, deps);
	});
	if (runPromise === null) {
		deps.sendTo(ws, {
			type: "epic:feedback:rejected",
			epicId,
			reasonCode: "in_flight",
			reason: "Another decomposition attempt is already running.",
		});
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
	}
};

async function runFeedbackAttempt(
	initialEpic: PersistedEpic,
	trimmedText: string,
	deps: HandlerDeps,
): Promise<void> {
	// Reload latest epic state inside the lock for a fresh copy.
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

	// Resolve the repoDir BEFORE deleting the prior workflows: use one of the
	// prior workflows' targetRepository if available.
	const priorEpicForDelete = initialEpic;
	let repoDir: string | null = null;
	for (const wfId of priorEpicForDelete.workflowIds) {
		const loaded = await deps.sharedStore.load(wfId);
		if (loaded?.targetRepository) {
			repoDir = loaded.targetRepository;
			break;
		}
	}

	// Delete prior child workflows.
	await deleteChildWorkflows(priorEpicForDelete, deps);
	if (!repoDir) {
		// Fall back: no workflows available. Use the epic description's repo guess — none stored.
		// We can't proceed without a repoDir. Persist an error outcome and report.
		entry.outcome = "error";
		epic = {
			...epic,
			status: "error",
			errorMessage: "No target repository available for feedback attempt.",
			feedbackHistory: epic.feedbackHistory.map((e) => (e.id === entry.id ? entry : e)),
		};
		await deps.sharedEpicStore.save(epic);
		deps.broadcast({
			type: "epic:feedback:history",
			epicId,
			entries: epic.feedbackHistory,
			sessionContextLost: epic.sessionContextLost,
		});
		deps.broadcast({
			type: "epic:error",
			epicId,
			message: epic.errorMessage ?? "Feedback attempt failed",
		});
		return;
	}

	let capturedSessionId: string | null = null;
	const resumeSessionId = epic.decompositionSessionId;
	deps.sharedAuditLogger.logDecompositionResumed({
		epicId,
		sessionId: resumeSessionId,
		attemptReason: "feedback",
	});

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
			// Rebuild prompt: original description + accumulated feedback texts.
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
			} catch (err2) {
				entry.outcome = "error";
				epic = {
					...epic,
					status: "error",
					errorMessage: toErrorMessage(err2),
					feedbackHistory: epic.feedbackHistory.map((e) => (e.id === entry.id ? entry : e)),
				};
				await deps.sharedEpicStore.save(epic);
				deps.broadcast({
					type: "epic:feedback:history",
					epicId,
					entries: epic.feedbackHistory,
					sessionContextLost: epic.sessionContextLost,
				});
				deps.broadcast({
					type: "epic:error",
					epicId,
					message: toErrorMessage(err2),
				});
				return;
			}
		} else {
			entry.outcome = "error";
			epic = {
				...epic,
				status: "error",
				errorMessage: toErrorMessage(err),
				feedbackHistory: epic.feedbackHistory.map((e) => (e.id === entry.id ? entry : e)),
			};
			await deps.sharedEpicStore.save(epic);
			deps.broadcast({
				type: "epic:feedback:history",
				epicId,
				entries: epic.feedbackHistory,
				sessionContextLost: epic.sessionContextLost,
			});
			deps.broadcast({
				type: "epic:error",
				epicId,
				message: toErrorMessage(err),
			});
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
		return;
	}

	const { workflows } = await createEpicWorkflows(result, repoDir, epicId, null);
	const workflowIds: string[] = [];
	for (const workflow of workflows) {
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
