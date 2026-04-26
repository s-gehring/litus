import { randomUUID } from "node:crypto";
import { analyzeEpic } from "../epic-analyzer";
import { toErrorMessage } from "../errors";
import { logger } from "../logger";
import type { ClientMessage, PersistedEpic } from "../types";
import { createEpicWorkflows } from "../workflow-engine";
import type { MessageHandler } from "./handler-types";
import { resolveTargetRepo, validateTextInput } from "./handler-types";

function buildEpicData(
	fields: Pick<PersistedEpic, "epicId" | "description" | "status" | "title" | "workflowIds"> & {
		analysisStartedAt: number;
		infeasibleNotes: string | null;
		summary: string | null;
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

	try {
		const result = await analyzeEpic(trimmedDesc, repoDir, deps.epicAnalysisRef, undefined, {
			onOutput: (text) => deps.emitText({ kind: "epic", epicId }, text),
			onTools: (tools) => deps.broadcast({ type: "epic:tools", epicId, tools }),
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
		const epicSnapshot = { archived: epic.archived, archivedAt: epic.archivedAt };
		epic.archived = false;
		epic.archivedAt = null;
		try {
			await deps.sharedEpicStore.save(epic);
		} catch (err) {
			epic.archived = epicSnapshot.archived;
			epic.archivedAt = epicSnapshot.archivedAt;
			throw err;
		}
		for (const childId of epic.workflowIds) {
			const child = await loadLiveOrPersisted(deps, childId);
			if (!child?.archived) continue;
			const snapshot = {
				archived: child.archived,
				archivedAt: child.archivedAt,
				updatedAt: child.updatedAt,
			};
			child.archived = false;
			child.archivedAt = null;
			child.updatedAt = new Date().toISOString();
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
