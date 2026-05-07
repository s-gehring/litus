import { createInterface } from "node:readline";
import type { ServerWebSocket } from "bun";
import { AlertQueue } from "./alert-queue";
import { AlertStore } from "./alert-store";
import { AuditLogger } from "./audit-logger";
import { AutoArchiver } from "./auto-archiver";
import { CLIRunner } from "./cli-runner";
import { configStore } from "./config-store";
import {
	getDefaultModelInfo,
	initializeDefaultModelInfo,
	onDefaultModelInfoChange,
} from "./default-model-info";
import { computeDependencyStatus } from "./dependency-resolver";
import type { EpicAnalysisProcess } from "./epic-analyzer";
import { EpicStore } from "./epic-store";
import { recoverInterruptedFeedbackImplementer } from "./feedback-implementer";
import { setGitLogCallback } from "./git-logger";
import { logger } from "./logger";
import { createDefaultManagedRepoStore } from "./managed-repo-store";
import { PipelineOrchestrator } from "./pipeline-orchestrator";
import { type PipelineStepName, STEP } from "./pipeline-steps";
import { validateOutgoingInDev } from "@litus/protocol";
import type { ServerMessage } from "./protocol";
import { QuestionDetector } from "./question-detector";
import { ReviewClassifier } from "./review-classifier";
import { createAlertBroadcasters } from "./server/alert-broadcast";
import {
	clearClientRouteOnClose,
	handleAlertClearAll,
	handleAlertDismiss,
	handleAlertList,
	handleAlertRouteChanged,
} from "./server/alert-handlers";
import { handleClientWarning } from "./server/client-warning-handler";
import { handleConfigGet, handleConfigReset, handleConfigSave } from "./server/config-handlers";
import { createEmitText } from "./server/emit-text";
import {
	handleArchiveEpic,
	handleEpicAbort,
	handleEpicAbortAll,
	handleEpicFeedback,
	handleEpicFeedbackAckContextLost,
	handleEpicPauseAll,
	handleEpicResumeAll,
	handleEpicStart,
	handleEpicStartFirstLevel,
	handleUnarchiveEpic,
} from "./server/epic-handlers";
import type { HandlerDeps, WsData } from "./server/handler-types";
import { MessageRouter } from "./server/message-router";
import { handlePurgeAll } from "./server/purge-handlers";
import {
	handleTelegramAcknowledge,
	handleTelegramTest,
	sendTelegramStatusTo,
	setTelegramHandlerDeps,
} from "./server/telegram-handlers";
import { broadcastPersistedWorkflowState } from "./server/workflow-broadcaster";
import {
	handleAbort,
	handleAnswer,
	handleArchiveWorkflow,
	handleArtifactContent,
	handleArtifactDownload,
	handleArtifactList,
	handleFeedback,
	handleFinalize,
	handleForceStart,
	handlePause,
	handleResume,
	handleRetry,
	handleRetryWorkflow,
	handleSkip,
	handleStart,
	handleStartExisting,
	handleUnarchiveWorkflow,
} from "./server/workflow-handlers";
import { getMimeType, resolveStaticPath } from "./static-files";
import { Summarizer } from "./summarizer";
import { normalizePath } from "./target-repo-validator";
import { TelegramFailureState } from "./telegram/telegram-failure-state";
import { TelegramNotifier } from "./telegram/telegram-notifier";
import { fetchTelegramTransport } from "./telegram/telegram-transport";
import { maybeBuildE2ETransport } from "./telegram/telegram-transport-e2e";
import type { AspectState, ToolUsage, Workflow, WorkflowState } from "./types";
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

// Per-WS-connection current path (for create-as-seen and route-triggered seen).
const clientRoutes = new Map<ServerWebSocket<WsData>, string>();

// E2E-only: track open WebSockets so the harness can deterministically drop them
// mid-run. Gated on LITUS_E2E_SCENARIO — in production this stays null and
// every branch below is a no-op. See specs/001-ws-reconnect-e2e/contracts/drop-ws.md.
const activeWebSockets: Set<ServerWebSocket<WsData>> | null = process.env.LITUS_E2E_SCENARIO
	? new Set<ServerWebSocket<WsData>>()
	: null;

// ── Telegram integration ────────────────────────────────
const telegramTransport = maybeBuildE2ETransport() ?? fetchTelegramTransport;
const telegramFailureState = new TelegramFailureState();
/**
 * Resolve the public base URL embedded in Telegram alert links. `LITUS_PUBLIC_URL`
 * (trailing slashes stripped) overrides the default `http://localhost:<port>`;
 * set it when Litus runs behind a reverse proxy or tunnel so recipients can
 * actually reach the linked workflow.
 */
function getTelegramBaseUrl(): string {
	const fromEnv = process.env.LITUS_PUBLIC_URL?.trim();
	if (fromEnv) return fromEnv.replace(/\/+$/, "");
	// Cannot use optional chaining here: `server` is declared with `let server!` and
	// referencing it before assignment throws at runtime. The `typeof` guard
	// short-circuits so we never touch the binding before initialization.
	const port = typeof server !== "undefined" && server ? server.port : BASE_PORT;
	return `http://localhost:${port}`;
}
const telegramNotifier = new TelegramNotifier({
	getSettings: () => configStore.get().telegram,
	getBaseUrl: getTelegramBaseUrl,
	transport: telegramTransport,
	failureState: telegramFailureState,
});
setTelegramHandlerDeps({
	failureState: telegramFailureState,
	transport: telegramTransport,
	configStore,
	broadcast: (msg) => broadcast(msg),
	sendTo: (ws, msg) => sendTo(ws, msg),
});

const { emitAlert, markAlertsSeenWhere } = createAlertBroadcasters(
	sharedAlertQueue,
	(msg) => broadcast(msg),
	() => clientRoutes.values(),
	{
		onAlertAccepted: (alert) => {
			// `notify` is a fire-and-forget that never rejects (it swallows its
			// own dispatch error). `void` discards the chained promise.
			void telegramNotifier.notify(alert);
		},
	},
);

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
			emitText({ kind: "workflow", workflowId }, text);
		},
		onTools: (workflowId: string, tools: ToolUsage[]) => {
			broadcast({ type: "workflow:tools", workflowId, tools });
		},
		onAspectOutput: (workflowId: string, aspectId: string, text: string) => {
			broadcast({ type: "workflow:aspect:output", workflowId, aspectId, text });
		},
		onAspectTools: (workflowId: string, aspectId: string, tools: ToolUsage[]) => {
			broadcast({ type: "workflow:aspect:tools", workflowId, aspectId, tools });
		},
		onAspectState: (workflowId: string, aspectId: string, state: AspectState) => {
			broadcast({ type: "workflow:aspect:state", workflowId, aspectId, state });
		},
		onComplete: (workflowId: string) => {
			broadcastWorkflowState(workflowId);
			orchestrators.delete(workflowId);
		},
		onError: (workflowId: string, error: string) => {
			logger.error(`[pipeline] Step error (${workflowId}): ${error}`);
			emitText({ kind: "workflow", workflowId }, `Error: ${error}`);
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
		onAlertMarkSeenWhere: markAlertsSeenWhere,
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
		steps: steps.map(({ sessionId, prompt: _p, pid: _pid, ...step }) => ({
			...step,
			hasResumableSession: typeof sessionId === "string" && sessionId !== "",
		})),
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
	validateOutgoingInDev(msg);
	server.publish(WS_TOPIC, JSON.stringify(msg));
}

export const emitText = createEmitText(broadcast);

setGitLogCallback((text, workflowId) => {
	emitText(workflowId ? { kind: "workflow", workflowId } : { kind: "console" }, text);
});

function sendTo(ws: ServerWebSocket<WsData>, msg: ServerMessage) {
	validateOutgoingInDev(msg);
	ws.send(JSON.stringify(msg));
}

function broadcastWorkflowState(workflowId: string) {
	const state = getWorkflowState(workflowId);
	if (state) {
		broadcast({ type: "workflow:state", workflow: state });
		return;
	}
	// After abortPipeline deletes the orchestrator, late-arriving callbacks (e.g.
	// the post-abort commit-backfill in pipeline-orchestrator.abortPipeline) still
	// invoke onStateChange. Fall back to the persisted workflow so the client sees
	// the final commitRefs without needing a page reload.
	void broadcastPersistedWorkflowState(workflowId, sharedStore, stripInternalFields, broadcast);
}

// ── HandlerDeps construction ────────────────────────────
const deps: HandlerDeps = {
	orchestrators,
	broadcast,
	emitText,
	sendTo,
	sharedStore,
	sharedEpicStore,
	sharedAuditLogger,
	sharedCliRunner,
	sharedSummarizer,
	configStore,
	managedRepoStore,
	alertQueue: sharedAlertQueue,
	clientRoutes,
	markAlertsSeenWhere,
	epicAnalysisRef,
	createOrchestrator,
	broadcastWorkflowState,
	stripInternalFields,
	getAllWorkflowStates,
};

// Auto-archive sweeper: flips any non-archived, non-epic-child workflow in a
// terminal state (completed/aborted/error) to archived after it's been resting
// for `AUTO_ARCHIVE_THRESHOLD_MS`. Users can halt it via `auto-archive:stop`.
const autoArchiver = new AutoArchiver(deps);

// ── Message router setup ────────────────────────────────
const router = new MessageRouter();
router.register("workflow:start", handleStart);
router.register("workflow:answer", handleAnswer);
router.register("workflow:skip", handleSkip);
router.register("workflow:pause", handlePause);
router.register("workflow:resume", handleResume);
router.register("workflow:abort", handleAbort);
router.register("workflow:retry", handleRetry);
router.register("workflow:retry-workflow", handleRetryWorkflow);
router.register("workflow:start-existing", handleStartExisting);
router.register("workflow:force-start", handleForceStart);
router.register("workflow:feedback", handleFeedback);
router.register("workflow:finalize", handleFinalize);
router.register("workflow:archive", handleArchiveWorkflow);
router.register("workflow:unarchive", handleUnarchiveWorkflow);
router.register("config:get", handleConfigGet);
router.register("config:save", handleConfigSave);
router.register("config:reset", handleConfigReset);
router.register("epic:start", handleEpicStart);
router.register("epic:abort", handleEpicAbort);
router.register("epic:feedback", handleEpicFeedback);
router.register("epic:feedback:ack-context-lost", handleEpicFeedbackAckContextLost);
router.register("epic:start-first-level", handleEpicStartFirstLevel);
router.register("epic:pause-all", handleEpicPauseAll);
router.register("epic:resume-all", handleEpicResumeAll);
router.register("epic:abort-all", handleEpicAbortAll);
router.register("epic:archive", handleArchiveEpic);
router.register("epic:unarchive", handleUnarchiveEpic);
router.register("purge:all", handlePurgeAll);
router.register("auto-archive:stop", (_ws, _data, d) => {
	autoArchiver.stop();
	d.broadcast({ type: "auto-archive:state", active: autoArchiver.isActive() });
});
router.register("auto-archive:start", (_ws, _data, d) => {
	autoArchiver.start();
	d.broadcast({ type: "auto-archive:state", active: autoArchiver.isActive() });
});
router.register("alert:list", handleAlertList);
router.register("alert:dismiss", handleAlertDismiss);
router.register("alert:clear-all", handleAlertClearAll);
router.register("alert:route-changed", handleAlertRouteChanged);
router.register("client:warning", handleClientWarning);
router.register("telegram:test", handleTelegramTest);
router.register("telegram:acknowledge", handleTelegramAcknowledge);

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

export async function handleFolderExists(raw: string | null): Promise<Response> {
	if (!raw || raw.trim() === "") {
		return Response.json({ error: "path required" }, { status: 400 });
	}
	const { stat } = await import("node:fs/promises");
	const { homedir } = await import("node:os");
	const { resolve, relative, isAbsolute } = await import("node:path");
	const resolved = normalizePath(raw);
	// Allow-list: paths outside the user's home directory are reported
	// uniformly as `permission_denied`. This prevents an unauthenticated caller
	// from probing the wider filesystem via the finer-grained
	// `not_found` / `not_a_directory` / `permission_denied` distinctions.
	// The contract's discriminated union pairs `permission_denied` with
	// `exists: true`, so we report that shape here even when we can't observe
	// the path — the client maps to "Folder is not accessible (permission
	// denied)." (see folderErrorMessageFor).
	const home = homedir();
	const absResolved = isAbsolute(resolved) ? resolved : resolve(home, resolved);
	const rel = relative(home, absResolved);
	const outsideHome = rel.startsWith("..") || isAbsolute(rel);
	if (outsideHome) {
		return Response.json({ exists: true, usable: false, reason: "permission_denied" });
	}
	try {
		// Stat the resolved ABSOLUTE form — `resolved` may be a relative path
		// that the OS would resolve against the server's CWD rather than `home`,
		// which would escape the allow-list above.
		const st = await stat(absResolved);
		if (!st.isDirectory()) {
			return Response.json({ exists: true, usable: false, reason: "not_a_directory" });
		}
		// A local folder is only "usable" as a target repo if it's a git
		// repository. `.git` is a directory for standard repos and a file for
		// worktrees / submodules — `stat` accepts either kind.
		const { join } = await import("node:path");
		try {
			await stat(join(absResolved, ".git"));
		} catch {
			return Response.json({ exists: true, usable: false, reason: "not_a_git_repo" });
		}
		return Response.json({ exists: true, usable: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return Response.json({ exists: false, usable: false, reason: "not_found" });
		}
		if (code === "EACCES" || code === "EPERM") {
			return Response.json({ exists: true, usable: false, reason: "permission_denied" });
		}
		logger.warn(`[folder-exists] Unexpected stat error for ${absResolved}: ${err}`);
		return Response.json({ error: "internal" }, { status: 500 });
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

			// ── Artifact endpoints ───────────────────────────────
			if (req.method === "GET") {
				const artifactMatch = url.pathname.match(
					/^\/api\/workflows\/([^/]+)\/artifacts(?:\/([^/]+)\/(content|download))?$/,
				);
				if (artifactMatch) {
					const workflowId = decodeURIComponent(artifactMatch[1]);
					const artifactId = artifactMatch[2] ? decodeURIComponent(artifactMatch[2]) : undefined;
					const action = artifactMatch[3];
					if (!artifactId) {
						return await handleArtifactList(workflowId, deps);
					}
					if (action === "content") {
						return await handleArtifactContent(workflowId, artifactId, deps);
					}
					if (action === "download") {
						return await handleArtifactDownload(workflowId, artifactId, deps);
					}
				}
			}

			if (url.pathname === "/api/folder-exists" && req.method === "GET") {
				return await handleFolderExists(url.searchParams.get("path"));
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
				if (activeWebSockets) activeWebSockets.add(ws);
				const workflows = await getAllWorkflowStates();
				sendTo(ws, { type: "workflow:list", workflows });
				sendTo(ws, {
					type: "default-model:info",
					modelInfo: getDefaultModelInfo(),
				});
				const epics = await sharedEpicStore.loadAll();
				if (epics.length > 0) {
					sendTo(ws, { type: "epic:list", epics });
				}
				sendTo(ws, { type: "alert:list", alerts: sharedAlertQueue.list() });
				sendTelegramStatusTo(ws, {
					sendTo,
					failureState: telegramFailureState,
				});
			},
			message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
				router.dispatch(ws, message, deps);
			},
			close(ws: ServerWebSocket<WsData>) {
				ws.unsubscribe(WS_TOPIC);
				if (activeWebSockets) activeWebSockets.delete(ws);
				clearClientRouteOnClose(ws, clientRoutes);
			},
		},
	});
}

// Drop any epic stuck in `analyzing` from a prior process — its in-memory
// analyzer task did not survive the restart, so the persisted placeholder
// (written by handleEpicStart before the slow analyze call) would otherwise
// linger forever as a ghost row. Must complete before Bun.serve accepts WS
// connections so the first `epic:list` reflects the cleaned-up file.
try {
	await sharedEpicStore.dropAnalyzing();
} catch (err) {
	logger.error(`[startup] Failed to drop stale analyzing epics: ${err}`);
}

let server!: ReturnType<typeof Bun.serve<WsData>>;
for (let i = 0; i < MAX_PORT_RETRIES; i++) {
	const port = BASE_PORT + i;
	try {
		server = startServer(port);
		logger.info(`Litus running at http://localhost:${server.port}`);
		break;
	} catch (err) {
		if (i === MAX_PORT_RETRIES - 1) throw err;
		logger.warn(`Port ${port} in use, trying ${port + 1}...`);
	}
}

// Wire failure-state broadcasts after `server` is assigned: `broadcast`
// dereferences `server`, and listener invocations would otherwise depend on a
// runtime-ordering coincidence (recordFailure can only fire from `notify`,
// which only fires from emitAlert, which only fires after orchestrators are
// wired up). Subscribing here removes that hidden contract.
telegramFailureState.subscribe((status) => {
	broadcast({ type: "telegram:status", ...status });
});

// E2E-only: stdin line-protocol reader for harness-driven control commands.
// Gated on LITUS_E2E_SCENARIO — in production this block never registers.
// See specs/001-ws-reconnect-e2e/contracts/drop-ws.md.
if (activeWebSockets) {
	const rl = createInterface({ input: process.stdin });
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let cmd: { type?: string };
		try {
			cmd = JSON.parse(trimmed);
		} catch {
			logger.warn(`[e2e-control] ignoring non-JSON stdin line: ${trimmed}`);
			return;
		}
		if (cmd.type === "drop-ws") {
			for (const ws of activeWebSockets) {
				try {
					// 1001 "Going Away" reflects real-world drops (proxy timeout,
					// laptop sleep) more faithfully than the default 1000 Normal
					// Closure. The client reacts to `ws.onclose` regardless of
					// code, but matching production drop semantics keeps the
					// test honest.
					ws.close(1001, "test-drop");
				} catch (err) {
					// tolerant: already-closing sockets throw synchronously on some runtimes.
					// Log so a new error shape (bad args, protocol state violation) leaves
					// a trail in server.log instead of silently succeeding. This block is
					// already E2E-gated, so the noise never reaches production.
					logger.warn(`[e2e-control] ws.close threw: ${err}`);
				}
			}
			return;
		}
		logger.warn(`[e2e-control] ignoring unrecognized command: ${trimmed}`);
	});
}

// Detect the default model so the UI can show "Default (Opus 4.7)" rather
// than a bare "Default". Runs async; listeners broadcast when the result lands.
onDefaultModelInfoChange((info) => {
	broadcast({ type: "default-model:info", modelInfo: info });
});
initializeDefaultModelInfo();

// Kill all child CLI processes on exit so they don't outlive the server.
// This covers graceful shutdown, Ctrl+C, and SIGTERM.
function cleanupChildren() {
	sharedCliRunner.killAll();
}
process.on("exit", cleanupChildren);
async function gracefulExit(): Promise<void> {
	autoArchiver.stop();
	cleanupChildren();
	try {
		await sharedAlertQueue.flush();
	} catch {
		// Errors are logged inside flush().
	}
	process.exit(0);
}
process.on("SIGINT", () => {
	void gracefulExit();
});
process.on("SIGTERM", () => {
	void gracefulExit();
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
			if (workflow.status === "completed" || workflow.status === "aborted") {
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
					// FR-020: aborted-via-restart path — mark in-flight entry aborted
					// and rewind to merge-pr pause. We do not auto-retry the agent.
					recoverInterruptedFeedbackImplementer(workflow);
					await sharedStore.save(workflow);
					logger.info(
						`[startup] Aborted interrupted feedback-implementer for workflow ${workflow.id} and rewound to merge-pr pause`,
					);
				} else if (
					workflow.workflowKind === "ask-question" &&
					runningStep &&
					(runningStep.name === STEP.DECOMPOSE ||
						runningStep.name === STEP.RESEARCH_ASPECT ||
						runningStep.name === STEP.SYNTHESIZE ||
						runningStep.name === STEP.FINALIZE)
				) {
					// Ask-question steps are file-based: a captured CLI sessionId is
					// gone after restart and `claude --resume` will not produce the
					// expected artifacts. Force the step to `error` so the user can
					// hit Retry, which re-dispatches through the dedicated runners.
					workflow.activeWorkStartedAt = null;
					runningStep.status = "error";
					runningStep.error = "Server restarted — ask-question step needs re-dispatch";
					runningStep.pid = null;
					workflow.status = "error";
					workflow.updatedAt = new Date().toISOString();
					await sharedStore.save(workflow);
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
					// Keep the managed-repo refcount intact: error is retriable, so the
					// workflow still needs its clone on disk. seedFromWorkflows counts
					// error workflows as consumers; this force-transition does not
					// change the count.
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
				if (w.status === "error" || w.status === "aborted") errorIds.add(w.id);
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
	autoArchiver.start();
})();
