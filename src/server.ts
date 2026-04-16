import type { ServerWebSocket } from "bun";
import { AlertQueue } from "./alert-queue";
import { AlertStore } from "./alert-store";
import { AuditLogger } from "./audit-logger";
import { CLIRunner } from "./cli-runner";
import { configStore } from "./config-store";
import { computeDependencyStatus } from "./dependency-resolver";
import type { EpicAnalysisProcess } from "./epic-analyzer";
import { EpicStore } from "./epic-store";
import { recoverInterruptedFeedbackImplementer } from "./feedback-implementer";
import { setGitLogCallback } from "./git-logger";
import { logger } from "./logger";
import { createDefaultManagedRepoStore } from "./managed-repo-store";
import { PipelineOrchestrator } from "./pipeline-orchestrator";
import { QuestionDetector } from "./question-detector";
import { ReviewClassifier } from "./review-classifier";
import { handleAlertDismiss, handleAlertList } from "./server/alert-handlers";
import { handleConfigGet, handleConfigReset, handleConfigSave } from "./server/config-handlers";
import { handleEpicCancel, handleEpicStart } from "./server/epic-handlers";
import type { HandlerDeps, WsData } from "./server/handler-types";
import { MessageRouter } from "./server/message-router";
import { handlePurgeAll } from "./server/purge-handlers";
import { broadcastPersistedWorkflowState } from "./server/workflow-broadcaster";
import {
	handleAbort,
	handleAnswer,
	handleFeedback,
	handleForceStart,
	handlePause,
	handleResume,
	handleRetry,
	handleSkip,
	handleStart,
	handleStartExisting,
} from "./server/workflow-handlers";
import { getMimeType, resolveStaticPath } from "./static-files";
import { Summarizer } from "./summarizer";
import { normalizePath } from "./target-repo-validator";
import {
	type PipelineStepName,
	type ServerMessage,
	STEP,
	type ToolUsage,
	type Workflow,
	type WorkflowState,
} from "./types";
import { WorkflowStore } from "./workflow-store";

const BASE_PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_PORT_RETRIES = 10;
const WS_TOPIC = "workflow";

// Shared dependencies across all orchestrator instances
const sharedStore = new WorkflowStore();
const sharedEpicStore = new EpicStore();
const sharedCliRunner = new CLIRunner();
const sharedSummarizer = new Summarizer();
const sharedAuditLogger = new AuditLogger();
const managedRepoStore = createDefaultManagedRepoStore();
const sharedAlertQueue = new AlertQueue(new AlertStore());

// WorkflowManager: holds one PipelineOrchestrator per active workflow
const orchestrators = new Map<string, PipelineOrchestrator>();

// ── Epic analysis state ──────────────────────────────────
const epicAnalysisRef: { current: EpicAnalysisProcess | null } = { current: null };

function emitAlert(input: Omit<import("./types").Alert, "id" | "createdAt">): void {
	const result = sharedAlertQueue.emit(input);
	if (!result) return;
	broadcast({ type: "alert:created", alert: result.alert });
	if (result.evictedId) {
		broadcast({ type: "alert:dismissed", alertIds: [result.evictedId] });
	}
}

function dismissAlertsWhere(filter: {
	type: import("./types").AlertType;
	workflowId?: string;
	epicId?: string;
}): void {
	const removed = sharedAlertQueue.dismissWhere(filter);
	if (removed.length > 0) {
		broadcast({ type: "alert:dismissed", alertIds: removed });
	}
}

function createCallbacks() {
	return {
		onStepChange: (
			workflowId: string,
			previousStep: PipelineStepName | null,
			currentStep: PipelineStepName,
			currentStepIndex: number,
			reviewIteration: number,
		) => {
			broadcast({
				type: "workflow:step-change",
				workflowId,
				previousStep,
				currentStep,
				currentStepIndex,
				reviewIteration,
			});
		},
		onOutput: (workflowId: string, text: string) => {
			broadcast({ type: "workflow:output", workflowId, text });
		},
		onTools: (workflowId: string, tools: ToolUsage[]) => {
			broadcast({ type: "workflow:tools", workflowId, tools });
		},
		onComplete: (workflowId: string) => {
			broadcastWorkflowState(workflowId);
			orchestrators.delete(workflowId);
		},
		onError: (workflowId: string, error: string) => {
			logger.error(`[pipeline] Step error (${workflowId}): ${error}`);
			broadcast({ type: "workflow:output", workflowId, text: `Error: ${error}` });
			broadcastWorkflowState(workflowId);
		},
		onStateChange: (workflowId: string) => {
			broadcastWorkflowState(workflowId);
		},
		onEpicDependencyUpdate: (
			dependentWorkflowId: string,
			status: import("./types").EpicDependencyStatus,
			blockingWorkflows: string[],
		) => {
			broadcast({
				type: "epic:dependency-update",
				workflowId: dependentWorkflowId,
				epicDependencyStatus: status,
				blockingWorkflows,
			});

			const depOrch = orchestrators.get(dependentWorkflowId);
			if (depOrch) {
				const depWorkflow = depOrch.getEngine().getWorkflow();
				if (depWorkflow) {
					depWorkflow.epicDependencyStatus = status;
					depWorkflow.updatedAt = new Date().toISOString();

					if (status === "satisfied" && depWorkflow.status === "waiting_for_dependencies") {
						depOrch.startPipelineFromWorkflow(depWorkflow);
					}
				}
			}

			broadcastWorkflowState(dependentWorkflowId);
		},
		onAlertEmit: emitAlert,
		onAlertDismissWhere: dismissAlertsWhere,
	};
}

function createOrchestrator(): PipelineOrchestrator {
	return new PipelineOrchestrator(createCallbacks(), {
		cliRunner: sharedCliRunner,
		questionDetector: new QuestionDetector(),
		reviewClassifier: new ReviewClassifier(),
		summarizer: sharedSummarizer,
		auditLogger: sharedAuditLogger,
		workflowStore: sharedStore,
		managedRepoStore,
	});
}

function stripInternalFields(w: Workflow): WorkflowState {
	const { steps, feedbackPreRunHead: _fph, ...rest } = w;
	return {
		...rest,
		steps: steps.map(({ sessionId: _sid, prompt: _p, pid: _pid, ...step }) => step),
	};
}

function getWorkflowState(workflowId: string): WorkflowState | null {
	const orch = orchestrators.get(workflowId);
	if (!orch) return null;
	const w = orch.getEngine().getWorkflow();
	if (!w) return null;
	return stripInternalFields(w);
}

async function getAllWorkflowStates(): Promise<WorkflowState[]> {
	const states: WorkflowState[] = [];

	for (const [_id, orch] of orchestrators) {
		const w = orch.getEngine().getWorkflow();
		if (w) states.push(stripInternalFields(w));
	}

	const allWorkflows = await sharedStore.loadAll();
	const activeIds = new Set(orchestrators.keys());
	for (const w of allWorkflows) {
		if (!activeIds.has(w.id)) {
			states.push(stripInternalFields(w));
		}
	}

	states.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
	return states;
}

function broadcast(msg: ServerMessage) {
	server.publish(WS_TOPIC, JSON.stringify(msg));
}

setGitLogCallback((text) => {
	broadcast({ type: "log", text });
});

function sendTo(ws: ServerWebSocket<WsData>, msg: ServerMessage) {
	ws.send(JSON.stringify(msg));
}

function broadcastWorkflowState(workflowId: string) {
	const state = getWorkflowState(workflowId);
	if (state) {
		broadcast({ type: "workflow:state", workflow: state });
		return;
	}
	// After cancelPipeline deletes the orchestrator, late-arriving callbacks (e.g.
	// the post-cancel commit-backfill in pipeline-orchestrator.cancelPipeline) still
	// invoke onStateChange. Fall back to the persisted workflow so the client sees
	// the final commitRefs without needing a page reload.
	void broadcastPersistedWorkflowState(workflowId, sharedStore, stripInternalFields, broadcast);
}

// ── HandlerDeps construction ────────────────────────────
const deps: HandlerDeps = {
	orchestrators,
	broadcast,
	sendTo,
	sharedStore,
	sharedEpicStore,
	sharedAuditLogger,
	sharedCliRunner,
	sharedSummarizer,
	configStore,
	managedRepoStore,
	alertQueue: sharedAlertQueue,
	epicAnalysisRef,
	createOrchestrator,
	broadcastWorkflowState,
	stripInternalFields,
	getAllWorkflowStates,
};

// ── Message router setup ────────────────────────────────
const router = new MessageRouter();
router.register("workflow:start", handleStart);
router.register("workflow:answer", handleAnswer);
router.register("workflow:skip", handleSkip);
router.register("workflow:pause", handlePause);
router.register("workflow:resume", handleResume);
router.register("workflow:abort", handleAbort);
router.register("workflow:retry", handleRetry);
router.register("workflow:start-existing", handleStartExisting);
router.register("workflow:force-start", handleForceStart);
router.register("workflow:feedback", handleFeedback);
router.register("config:get", handleConfigGet);
router.register("config:save", handleConfigSave);
router.register("config:reset", handleConfigReset);
router.register("epic:start", handleEpicStart);
router.register("epic:cancel", handleEpicCancel);
router.register("purge:all", handlePurgeAll);
router.register("alert:list", handleAlertList);
router.register("alert:dismiss", handleAlertDismiss);

// ── HTTP/WS server ──────────────────────────────────────
async function listSubdirectories(parentDir: string): Promise<string[]> {
	const { readdirSync, statSync } = await import("node:fs");
	const { join } = await import("node:path");
	try {
		const entries = readdirSync(parentDir);
		const folders: string[] = [];
		for (const entry of entries) {
			if (entry.startsWith(".")) continue;
			try {
				const full = join(parentDir, entry);
				if (statSync(full).isDirectory()) {
					folders.push(full);
				}
			} catch {
				// Skip entries we can't stat
			}
		}
		folders.sort((a, b) => a.localeCompare(b));
		return folders;
	} catch (err) {
		logger.warn(`[server] Failed to list subdirectories of ${parentDir}:`, err);
		return [];
	}
}

function startServer(port: number): ReturnType<typeof Bun.serve<WsData>> {
	return Bun.serve<WsData>({
		port,
		async fetch(req, server) {
			const url = new URL(req.url);

			if (url.pathname === "/ws") {
				const upgraded = server.upgrade(req, { data: {} });
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname === "/health") {
				const activeWorkflows: { id: string; step: string | null }[] = [];
				for (const [id, orch] of orchestrators) {
					const w = orch.getEngine().getWorkflow();
					if (w && (w.status === "running" || w.status === "waiting_for_input")) {
						activeWorkflows.push({
							id,
							step: w.steps[w.currentStepIndex]?.name ?? null,
						});
					}
				}
				return Response.json({ status: "ok", activeWorkflows });
			}

			if (url.pathname === "/api/suggest-folders" && req.method === "GET") {
				const parent = url.searchParams.get("parent");
				if (!parent) {
					return Response.json({ error: "parent parameter required" }, { status: 400 });
				}
				const folders = await listSubdirectories(normalizePath(parent));
				return Response.json({ folders });
			}

			const safePath = resolveStaticPath(url.pathname);
			if (safePath) {
				const file = Bun.file(safePath);
				if (await file.exists()) {
					return new Response(file, {
						headers: { "Content-Type": getMimeType(safePath) },
					});
				}
			}

			// SPA fallback: serve index.html for navigation requests only
			// (paths without a file extension) so the client-side router can handle them
			if (!url.pathname.includes(".")) {
				const indexFile = Bun.file("public/index.html");
				if (await indexFile.exists()) {
					return new Response(indexFile, {
						headers: { "Content-Type": "text/html" },
					});
				}
			}

			return new Response("Not Found", { status: 404 });
		},
		websocket: {
			async open(ws: ServerWebSocket<WsData>) {
				ws.subscribe(WS_TOPIC);
				const workflows = await getAllWorkflowStates();
				sendTo(ws, { type: "workflow:list", workflows });
				const epics = await sharedEpicStore.loadAll();
				if (epics.length > 0) {
					sendTo(ws, { type: "epic:list", epics });
				}
				sendTo(ws, { type: "alert:list", alerts: sharedAlertQueue.list() });
			},
			message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
				router.dispatch(ws, message, deps);
			},
			close(ws: ServerWebSocket<WsData>) {
				ws.unsubscribe(WS_TOPIC);
			},
		},
	});
}

let server!: ReturnType<typeof Bun.serve<WsData>>;
for (let i = 0; i < MAX_PORT_RETRIES; i++) {
	const port = BASE_PORT + i;
	try {
		server = startServer(port);
		logger.info(`Litus running at http://localhost:${port}`);
		break;
	} catch (err) {
		if (i === MAX_PORT_RETRIES - 1) throw err;
		logger.warn(`Port ${port} in use, trying ${port + 1}...`);
	}
}

// Kill all child CLI processes on exit so they don't outlive the server.
// This covers graceful shutdown, Ctrl+C, and SIGTERM.
function cleanupChildren() {
	sharedCliRunner.killAll();
}
process.on("exit", cleanupChildren);
process.on("SIGINT", () => {
	cleanupChildren();
	process.exit(0);
});
process.on("SIGTERM", () => {
	cleanupChildren();
	process.exit(0);
});

// Restore persisted alert queue on startup (fire-and-forget; initial WS
// `alert:list` messages sent before this resolves will just report an empty
// list — correct behavior for a fresh process).
sharedAlertQueue.loadFromDisk().catch((err) => {
	logger.error(`[startup] Failed to load alert queue: ${err}`);
});

// Restore persisted workflows on startup
(async () => {
	try {
		const allWorkflows = await sharedStore.loadAll();

		// Seed the managed-repo refcount from non-terminal workflows so the clone
		// directory isn't deleted while a workflow still depends on it.
		await managedRepoStore.seedFromWorkflows(allWorkflows);

		let restoredCount = 0;

		for (const workflow of allWorkflows) {
			if (workflow.status === "completed" || workflow.status === "cancelled") {
				continue;
			}

			const orch = createOrchestrator();
			orch.getEngine().setWorkflow(workflow);

			// Clear stale PIDs — child processes from the previous instance
			// were killed by the exit handler (or died with the parent).
			if (workflow.status === "waiting_for_input") {
				const waitingStep = workflow.steps.find((s) => s.status === "waiting_for_input");
				if (waitingStep?.pid) {
					waitingStep.pid = null;
					await sharedStore.save(workflow);
				}
				logger.info(
					`[startup] Restored waiting_for_input workflow ${workflow.id} (question pending)`,
				);
			}

			if (workflow.status === "running") {
				const runningStep = workflow.steps.find((s) => s.status === "running");
				if (runningStep?.pid) {
					runningStep.pid = null;
				}

				// monitor-ci is direct code execution — restart polling from scratch
				if (runningStep?.name === STEP.MONITOR_CI) {
					logger.info(`[startup] Restarting monitor-ci for workflow ${workflow.id}`);
					workflow.ciCycle.monitorStartedAt = null;
					orch.resumeMonitorCi(workflow.id);
				} else if (runningStep?.name === STEP.FEEDBACK_IMPLEMENTER) {
					// FR-020: cancelled-via-restart path — mark in-flight entry cancelled
					// and rewind to merge-pr pause. We do not auto-retry the agent.
					recoverInterruptedFeedbackImplementer(workflow);
					await sharedStore.save(workflow);
					logger.info(
						`[startup] Cancelled interrupted feedback-implementer for workflow ${workflow.id} and rewound to merge-pr pause`,
					);
				} else if (runningStep?.sessionId) {
					logger.info(
						`[startup] Resuming workflow ${workflow.id} step "${runningStep.name}" (session: ${runningStep.sessionId})`,
					);
					orch.resumeStep(workflow.id).catch((err) => {
						logger.error(`[startup] Failed to resume workflow ${workflow.id}: ${err}`);
					});
				} else {
					workflow.activeWorkStartedAt = null;
					if (runningStep) {
						runningStep.status = "error";
						runningStep.error = "Server restarted — no session to resume";
						runningStep.pid = null;
					}
					workflow.status = "error";
					// seedFromWorkflows above installed a ready(refCount=N) entry
					// that counted this workflow as a live consumer. Now that we've
					// force-transitioned it to error without running the normal
					// teardown, drain its refcount so the seeded entry drops to the
					// true number of consumers (and the clone is eventually deleted
					// when the others finish).
					if (workflow.managedRepo) {
						const { owner, repo } = workflow.managedRepo;
						workflow.managedRepo = null;
						await managedRepoStore
							.release(owner, repo)
							.catch((err) =>
								logger.warn(`[startup] managed-repo release failed for ${owner}/${repo}: ${err}`),
							);
					}
					workflow.updatedAt = new Date().toISOString();
					await sharedStore.save(workflow);
				}
			}

			orchestrators.set(workflow.id, orch);
			restoredCount++;
		}

		if (restoredCount > 0) {
			logger.info(`[startup] Restored ${restoredCount} workflow(s)`);
		}

		for (const workflow of allWorkflows) {
			if (workflow.status !== "waiting_for_dependencies") continue;
			if (!workflow.epicId || workflow.epicDependencies.length === 0) continue;

			const completedIds = new Set<string>();
			const errorIds = new Set<string>();
			for (const w of allWorkflows) {
				if (w.epicId !== workflow.epicId) continue;
				if (w.status === "completed") completedIds.add(w.id);
				if (w.status === "error" || w.status === "cancelled") errorIds.add(w.id);
			}

			const depStatus = computeDependencyStatus(workflow.epicDependencies, completedIds, errorIds);

			if (depStatus.status === "satisfied") {
				workflow.epicDependencyStatus = "satisfied";
				workflow.updatedAt = new Date().toISOString();
				await sharedStore.save(workflow);

				const orch = orchestrators.get(workflow.id);
				if (orch) {
					logger.info(`[startup] Auto-starting unblocked workflow ${workflow.id}`);
					orch.startPipelineFromWorkflow(workflow);
				}
			} else if (depStatus.status === "blocked") {
				workflow.epicDependencyStatus = "blocked";
				workflow.updatedAt = new Date().toISOString();
				await sharedStore.save(workflow);
			}
		}
	} catch (err) {
		logger.error(`[startup] Failed to restore workflows: ${err}`);
	}
})();
