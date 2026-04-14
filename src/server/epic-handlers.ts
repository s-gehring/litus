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
	};
}

export const handleEpicStart: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "epic:start" };
	const { description, targetRepository, autoStart, submissionId } = msg;

	const inputError = validateTextInput(description, "Epic description", 10);
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
			onOutput: (text) => deps.broadcast({ type: "epic:output", epicId, text }),
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
			// Infeasible: no child workflows are created, so the initial acquire
			// has no consumer to own it. Release the clone immediately.
			if (resolved.managedRepo) {
				await deps.managedRepoStore
					.release(resolved.managedRepo.owner, resolved.managedRepo.repo)
					.catch((relErr) => logger.warn(`[epic] infeasible release failed: ${relErr}`));
			}
			return;
		}

		const { workflows } = await createEpicWorkflows(result, repoDir, epicId);

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

		// For a managed clone, refCount is at 1 (the initial acquire). Bring it up
		// to N so each child workflow is counted as an independent consumer.
		if (resolved.managedRepo && workflows.length > 1) {
			await deps.managedRepoStore.bumpRefCount(
				resolved.managedRepo.owner,
				resolved.managedRepo.repo,
				workflows.length - 1,
			);
		}

		// Store the analysis duration on the first child workflow
		if (workflows.length > 0) {
			workflows[0].epicAnalysisMs = analysisMs;
		}

		const workflowIds: string[] = [];

		// Persist and register orchestrators for each workflow
		for (const workflow of workflows) {
			if (resolved.managedRepo) workflow.managedRepo = resolved.managedRepo;
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

export const handleEpicCancel: MessageHandler = (_ws, _data, deps) => {
	if (deps.epicAnalysisRef.current) {
		deps.epicAnalysisRef.current.kill();
		deps.epicAnalysisRef.current = null;
	}
};
