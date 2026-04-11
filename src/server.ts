import type { ServerWebSocket } from "bun";
import { AuditLogger } from "./audit-logger";
import { CLIRunner } from "./cli-runner";
import { configStore } from "./config-store";
import { computeDependencyStatus } from "./dependency-resolver";
import type { EpicAnalysisProcess } from "./epic-analyzer";
import { EpicStore } from "./epic-store";
import { setGitLogCallback } from "./git-logger";
import { PipelineOrchestrator } from "./pipeline-orchestrator";
import { QuestionDetector } from "./question-detector";
import { ReviewClassifier } from "./review-classifier";
import { handleConfigGet, handleConfigReset, handleConfigSave } from "./server/config-handlers";
import { handleEpicCancel, handleEpicStart } from "./server/epic-handlers";
import type { HandlerDeps, WsData } from "./server/handler-types";
import { MessageRouter } from "./server/message-router";
import { handlePurgeAll } from "./server/purge-handlers";
import {
	handleAbort,
	handleAnswer,
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

// WorkflowManager: holds one PipelineOrchestrator per active workflow
const orchestrators = new Map<string, PipelineOrchestrator>();

// ── Epic analysis state ──────────────────────────────────
const epicAnalysisRef: { current: EpicAnalysisProcess | null } = { current: null };

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
			console.error(`[pipeline] Step error (${workflowId}): ${error}`);
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
	});
}

function stripInternalFields(w: Workflow): WorkflowState {
	const { steps, ...rest } = w;
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
	}
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
router.register("config:get", handleConfigGet);
router.register("config:save", handleConfigSave);
router.register("config:reset", handleConfigReset);
router.register("epic:start", handleEpicStart);
router.register("epic:cancel", handleEpicCancel);
router.register("purge:all", handlePurgeAll);

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
	} catch {
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
		console.log(`Litus running at http://localhost:${port}`);
		break;
	} catch (err) {
		if (i === MAX_PORT_RETRIES - 1) throw err;
		console.warn(`Port ${port} in use, trying ${port + 1}...`);
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

// Restore persisted workflows on startup
(async () => {
	try {
		const allWorkflows = await sharedStore.loadAll();
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
				console.log(
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
					console.log(`[startup] Restarting monitor-ci for workflow ${workflow.id}`);
					workflow.ciCycle.monitorStartedAt = null;
					orch.resumeMonitorCi(workflow.id);
				} else if (runningStep?.sessionId) {
					console.log(
						`[startup] Resuming workflow ${workflow.id} step "${runningStep.name}" (session: ${runningStep.sessionId})`,
					);
					orch.resumeStep(workflow.id).catch((err) => {
						console.error(`[startup] Failed to resume workflow ${workflow.id}: ${err}`);
					});
				} else {
					workflow.activeWorkStartedAt = null;
					if (runningStep) {
						runningStep.status = "error";
						runningStep.error = "Server restarted — no session to resume";
						runningStep.pid = null;
					}
					workflow.status = "error";
					workflow.updatedAt = new Date().toISOString();
					await sharedStore.save(workflow);
				}
			}

			orchestrators.set(workflow.id, orch);
			restoredCount++;
		}

		if (restoredCount > 0) {
			console.log(`[startup] Restored ${restoredCount} workflow(s)`);
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
					console.log(`[startup] Auto-starting unblocked workflow ${workflow.id}`);
					orch.startPipelineFromWorkflow(workflow);
				}
			} else if (depStatus.status === "blocked") {
				workflow.epicDependencyStatus = "blocked";
				workflow.updatedAt = new Date().toISOString();
				await sharedStore.save(workflow);
			}
		}
	} catch (err) {
		console.error(`[startup] Failed to restore workflows: ${err}`);
	}
})();
