import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { AuditLogger } from "./audit-logger";
import { CLIRunner } from "./cli-runner";
import { configStore } from "./config-store";
import { computeDependencyStatus } from "./dependency-resolver";
import { analyzeEpic, type EpicAnalysisProcess } from "./epic-analyzer";
import { EpicStore } from "./epic-store";
import { gitSpawn, setGitLogCallback } from "./git-logger";
import { PipelineOrchestrator } from "./pipeline-orchestrator";
import { QuestionDetector } from "./question-detector";
import { ReviewClassifier } from "./review-classifier";
import { getMimeType, resolveStaticPath } from "./static-files";
import { Summarizer } from "./summarizer";
import { validateTargetRepository } from "./target-repo-validator";
import type {
	AppConfig,
	ClientMessage,
	PipelineStepName,
	ServerMessage,
	Workflow,
	WorkflowState,
} from "./types";
import { createEpicWorkflows } from "./workflow-engine";
import { WorkflowStore } from "./workflow-store";

type WsData = Record<string, never>;

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
		onTools: (workflowId: string, tools: Record<string, number>) => {
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

			// Update in-memory workflow state for all dependency statuses
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

function getWorkflowState(workflowId: string): WorkflowState | null {
	const orch = orchestrators.get(workflowId);
	if (!orch) return null;
	const w = orch.getEngine().getWorkflow();
	if (!w) return null;
	return stripInternalFields(w);
}

function stripInternalFields(w: Workflow): WorkflowState {
	const { steps, ...rest } = w;
	return {
		...rest,
		steps: steps.map(({ sessionId: _sid, prompt: _p, pid: _pid, ...step }) => step),
	};
}

async function getAllWorkflowStates(): Promise<WorkflowState[]> {
	const states: WorkflowState[] = [];

	// Get states from active orchestrators
	for (const [_id, orch] of orchestrators) {
		const w = orch.getEngine().getWorkflow();
		if (w) states.push(stripInternalFields(w));
	}

	// Also load terminal workflows from store that don't have active orchestrators
	const allWorkflows = await sharedStore.loadAll();
	const activeIds = new Set(orchestrators.keys());
	for (const w of allWorkflows) {
		if (!activeIds.has(w.id)) {
			states.push(stripInternalFields(w));
		}
	}

	// Sort by createdAt ascending (oldest first)
	states.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
	return states;
}

function broadcast(msg: ServerMessage) {
	server.publish(WS_TOPIC, JSON.stringify(msg));
}

// Forward git operation logs to all connected clients
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

async function handleStart(
	ws: ServerWebSocket<WsData>,
	specification: string,
	targetRepository?: string,
) {
	if (!specification.trim()) {
		sendTo(ws, { type: "error", message: "Specification must be non-empty" });
		return;
	}

	const validation = await validateTargetRepository(targetRepository);
	if (!validation.valid) {
		sendTo(ws, { type: "error", message: validation.error ?? "Invalid target repository" });
		return;
	}

	try {
		const orch = createOrchestrator();
		const workflow = await orch.startPipeline(specification.trim(), validation.effectivePath);
		orchestrators.set(workflow.id, orch);

		const state = stripInternalFields(workflow);
		broadcast({ type: "workflow:created", workflow: state });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to start workflow";
		sendTo(ws, { type: "error", message });
	}
}

function handleAnswer(
	ws: ServerWebSocket<WsData>,
	workflowId: string,
	questionId: string,
	answer: string,
) {
	if (!answer.trim()) {
		sendTo(ws, { type: "error", message: "Answer must be non-empty" });
		return;
	}

	const orch = orchestrators.get(workflowId);
	if (!orch) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow?.pendingQuestion || workflow.pendingQuestion.id !== questionId) {
		sendTo(ws, { type: "error", message: "Question not found or already answered" });
		return;
	}

	orch.answerQuestion(workflowId, questionId, answer.trim());
}

function handleSkip(ws: ServerWebSocket<WsData>, workflowId: string, questionId: string) {
	const orch = orchestrators.get(workflowId);
	if (!orch) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow?.pendingQuestion || workflow.pendingQuestion.id !== questionId) {
		sendTo(ws, { type: "error", message: "Question not found or already answered" });
		return;
	}

	orch.skipQuestion(workflowId, questionId);
}

function handlePause(ws: ServerWebSocket<WsData>, workflowId: string) {
	const orch = orchestrators.get(workflowId);
	if (!orch) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "running") return;

	orch.pause(workflowId);
}

function handleAbort(ws: ServerWebSocket<WsData>, workflowId: string) {
	const orch = orchestrators.get(workflowId);
	if (!orch) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow) return;

	// Abort is valid from paused, waiting_for_input, and waiting_for_dependencies
	if (
		workflow.status !== "paused" &&
		workflow.status !== "waiting_for_input" &&
		workflow.status !== "waiting_for_dependencies"
	) {
		return;
	}

	orch.cancelPipeline(workflowId);
	orchestrators.delete(workflowId);
}

function handleResume(ws: ServerWebSocket<WsData>, workflowId: string) {
	const orch = orchestrators.get(workflowId);
	if (!orch) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "paused") return;

	orch.resume(workflowId);
}

function handleConfigGet(ws: ServerWebSocket<WsData>) {
	sendTo(ws, { type: "config:state", config: configStore.get() });
}

function handleConfigSave(ws: ServerWebSocket<WsData>, partial: Partial<AppConfig>) {
	const { errors, warnings } = configStore.save(partial);
	if (errors.length > 0) {
		sendTo(ws, { type: "config:error", errors });
		return;
	}
	const config = configStore.get();
	const msg: ServerMessage = {
		type: "config:state",
		config,
		...(warnings.length > 0 ? { warnings } : {}),
	};
	broadcast(msg);
}

function handleConfigReset(_ws: ServerWebSocket<WsData>, key?: string) {
	configStore.reset(key);
	broadcast({ type: "config:state", config: configStore.get() });
}

// ── Epic analysis state ──────────────────────────────────
const epicAnalysisRef: { current: EpicAnalysisProcess | null } = { current: null };

async function handleEpicStart(
	ws: ServerWebSocket<WsData>,
	description: string,
	targetRepository: string | undefined,
	autoStart: boolean,
) {
	if (!description || description.trim().length < 10) {
		sendTo(ws, { type: "error", message: "Epic description must be at least 10 characters" });
		return;
	}

	const validation = await validateTargetRepository(targetRepository);
	if (!validation.valid) {
		sendTo(ws, { type: "error", message: validation.error ?? "Invalid target repository" });
		return;
	}
	const repoDir = validation.effectivePath;

	const epicId = randomUUID();
	const trimmedDesc = description.trim();
	const analysisStartedAt = Date.now();
	console.log(`[epic] Starting analysis (${epicId.slice(0, 8)}): "${trimmedDesc.slice(0, 80)}"`);

	broadcast({ type: "epic:created", epicId, description: trimmedDesc });

	// Generate summary async (non-blocking)
	sharedSummarizer
		.generateSpecSummary(trimmedDesc)
		.then(({ summary }) => {
			if (summary) {
				broadcast({ type: "epic:summary", epicId, summary });
			}
		})
		.catch((err) => {
			console.warn(`[epic] Summary generation failed: ${err}`);
		});

	try {
		const result = await analyzeEpic(trimmedDesc, repoDir, epicAnalysisRef, undefined, {
			onOutput: (text) => broadcast({ type: "epic:output", epicId, text }),
			onTools: (tools) => broadcast({ type: "epic:tools", epicId, tools }),
		});

		const analysisMs = Date.now() - analysisStartedAt;
		console.log(`[epic] Analysis complete (${epicId.slice(0, 8)}): ${result.specs.length} specs`);

		// Handle infeasible epic (empty specs with infeasibleNotes)
		if (result.specs.length === 0 && result.infeasibleNotes) {
			console.log(
				`[epic] Infeasible (${epicId.slice(0, 8)}): ${result.infeasibleNotes.slice(0, 80)}`,
			);
			const epicData = {
				epicId,
				description: trimmedDesc,
				status: "infeasible" as const,
				title: result.title,
				workflowIds: [],
				startedAt: new Date(analysisStartedAt).toISOString(),
				completedAt: new Date().toISOString(),
				errorMessage: null,
				infeasibleNotes: result.infeasibleNotes,
				analysisSummary: result.summary,
			};
			await sharedEpicStore.save(epicData);
			broadcast({
				type: "epic:infeasible",
				epicId,
				title: result.title,
				infeasibleNotes: result.infeasibleNotes,
			});
			return;
		}

		const { workflows } = await createEpicWorkflows(result, repoDir, epicId);

		// Store the analysis duration on the first child workflow
		if (workflows.length > 0) {
			workflows[0].epicAnalysisMs = analysisMs;
		}

		const workflowIds: string[] = [];

		// Persist and register orchestrators for each workflow
		for (const workflow of workflows) {
			await sharedStore.save(workflow);

			const orch = createOrchestrator();
			orch.getEngine().setWorkflow(workflow);
			orchestrators.set(workflow.id, orch);

			broadcast({ type: "workflow:created", workflow: stripInternalFields(workflow) });
			workflowIds.push(workflow.id);

			// Auto-start independent specs when autoStart is true
			if (autoStart && workflow.epicDependencyStatus === "satisfied") {
				orch.startPipelineFromWorkflow(workflow);
			}
		}

		const epicData = {
			epicId,
			description: trimmedDesc,
			status: "completed" as const,
			title: result.title,
			workflowIds,
			startedAt: new Date(analysisStartedAt).toISOString(),
			completedAt: new Date().toISOString(),
			errorMessage: null,
			infeasibleNotes: result.infeasibleNotes,
			analysisSummary: result.summary,
		};
		await sharedEpicStore.save(epicData);

		broadcast({
			type: "epic:result",
			epicId,
			title: result.title,
			specCount: result.specs.length,
			workflowIds,
			summary: result.summary,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Epic analysis failed";
		console.error(`[epic] Analysis failed (${epicId.slice(0, 8)}): ${message}`);
		if (err instanceof Error && err.stack) {
			console.error(`[epic] Stack trace: ${err.stack}`);
		}
		broadcast({ type: "epic:error", epicId, message });
	}
}

function handleEpicCancel() {
	if (epicAnalysisRef.current) {
		epicAnalysisRef.current.kill();
		epicAnalysisRef.current = null;
	}
}

function handleStartExisting(ws: ServerWebSocket<WsData>, workflowId: string) {
	const orch = orchestrators.get(workflowId);
	if (!orch) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "idle") {
		sendTo(ws, { type: "error", message: "Workflow is not idle" });
		return;
	}

	try {
		orch.startPipelineFromWorkflow(workflow);
	} catch (err) {
		sendTo(ws, { type: "error", message: `Failed to start workflow: ${err}` });
		return;
	}
	broadcastWorkflowState(workflowId);
}

function handleForceStart(ws: ServerWebSocket<WsData>, workflowId: string) {
	const orch = orchestrators.get(workflowId);
	if (!orch) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "waiting_for_dependencies") {
		sendTo(ws, { type: "error", message: "Workflow is not waiting for dependencies" });
		return;
	}

	workflow.epicDependencyStatus = "overridden";
	workflow.updatedAt = new Date().toISOString();

	try {
		orch.startPipelineFromWorkflow(workflow);
	} catch (err) {
		workflow.epicDependencyStatus = "waiting";
		sendTo(ws, { type: "error", message: `Failed to force-start workflow: ${err}` });
		return;
	}
	broadcastWorkflowState(workflowId);
}

function handleRetry(ws: ServerWebSocket<WsData>, workflowId: string) {
	const orch = orchestrators.get(workflowId);
	if (!orch) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "error") {
		sendTo(ws, { type: "error", message: "No failed step to retry" });
		return;
	}

	orch.retryStep(workflowId);
}

async function handlePurgeAll(): Promise<void> {
	const warnings: string[] = [];

	// 1. Kill all running orchestrators
	for (const [id, orch] of orchestrators) {
		try {
			const w = orch.getEngine().getWorkflow();
			if (w && (w.status === "running" || w.status === "waiting_for_input")) {
				orch.cancelPipeline(id);
			}
		} catch {
			// Best effort
		}
	}
	orchestrators.clear();

	// Cancel any in-progress epic analysis
	if (epicAnalysisRef.current) {
		epicAnalysisRef.current.kill();
		epicAnalysisRef.current = null;
	}

	// 2. Load all workflows to find worktrees and branches to clean up
	const allWorkflows = await sharedStore.loadAll();

	// Group by target repository for git cleanup
	const repoCleanup = new Map<string, { worktreePaths: string[]; branches: string[] }>();
	for (const w of allWorkflows) {
		if (!w.targetRepository) continue;
		let entry = repoCleanup.get(w.targetRepository);
		if (!entry) {
			entry = { worktreePaths: [], branches: [] };
			repoCleanup.set(w.targetRepository, entry);
		}
		if (w.worktreePath) {
			entry.worktreePaths.push(w.worktreePath);
		}
		// Collect branches to delete (feature branch or worktree branch, skip "master"/"main")
		const branch = w.featureBranch ?? w.worktreeBranch;
		if (branch && !["master", "main"].includes(branch)) {
			entry.branches.push(branch);
		}
	}

	// 3. Remove worktrees and delete branches per repository
	for (const [repo, { worktreePaths, branches }] of repoCleanup) {
		for (const wtPath of worktreePaths) {
			try {
				const result = await gitSpawn(["git", "worktree", "remove", wtPath, "--force"], {
					cwd: repo,
				});
				if (result.code !== 0) {
					warnings.push(`Worktree remove failed (${wtPath}): ${result.stderr}`);
				}
			} catch (err) {
				warnings.push(`Worktree remove error (${wtPath}): ${err}`);
			}
		}

		// Prune worktree metadata for any stale entries
		await gitSpawn(["git", "worktree", "prune"], { cwd: repo });

		for (const branch of branches) {
			try {
				const result = await gitSpawn(["git", "branch", "-D", branch], { cwd: repo });
				if (result.code !== 0 && !result.stderr.includes("not found")) {
					warnings.push(`Branch delete failed (${branch}): ${result.stderr}`);
				}
			} catch (err) {
				warnings.push(`Branch delete error (${branch}): ${err}`);
			}
		}
	}

	// 4. Wipe persistence: workflows, epics, audit logs
	await sharedStore.removeAll();
	await sharedEpicStore.removeAll();
	sharedAuditLogger.removeAll();

	console.log(
		`[purge] All data purged (${allWorkflows.length} workflows, ${repoCleanup.size} repos)`,
	);
	if (warnings.length > 0) {
		console.warn(`[purge] Warnings: ${warnings.join("; ")}`);
	}

	broadcast({ type: "purge:complete", warnings });
}

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
				// Skip entries we can't stat (permission errors, etc.)
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

			// WebSocket upgrade
			if (url.pathname === "/ws") {
				const upgraded = server.upgrade(req, { data: {} });
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// Health endpoint
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
				return Response.json({
					status: "ok",
					activeWorkflows,
				});
			}

			// Suggest folders — list subdirectories of a parent directory
			if (url.pathname === "/api/suggest-folders" && req.method === "GET") {
				const parent = url.searchParams.get("parent");
				if (!parent) {
					return Response.json({ error: "parent parameter required" }, { status: 400 });
				}
				const folders = await listSubdirectories(parent);
				return Response.json({ folders });
			}

			// Static file serving (CR-010: path traversal prevention)
			const safePath = resolveStaticPath(url.pathname);
			if (safePath) {
				const file = Bun.file(safePath);
				if (await file.exists()) {
					return new Response(file, {
						headers: { "Content-Type": getMimeType(safePath) },
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
				try {
					const msg = JSON.parse(String(message)) as ClientMessage;

					switch (msg.type) {
						case "workflow:start":
							handleStart(ws, msg.specification, msg.targetRepository).catch((err) => {
								const text = err instanceof Error ? err.message : "Internal error";
								sendTo(ws, { type: "error", message: text });
							});
							break;
						case "workflow:answer":
							handleAnswer(ws, msg.workflowId, msg.questionId, msg.answer);
							break;
						case "workflow:skip":
							handleSkip(ws, msg.workflowId, msg.questionId);
							break;
						case "workflow:pause":
							handlePause(ws, msg.workflowId);
							break;
						case "workflow:resume":
							handleResume(ws, msg.workflowId);
							break;
						case "workflow:abort":
							handleAbort(ws, msg.workflowId);
							break;
						case "workflow:retry":
							handleRetry(ws, msg.workflowId);
							break;
						case "epic:start":
							handleEpicStart(ws, msg.description, msg.targetRepository, msg.autoStart).catch(
								(err) => {
									const text = err instanceof Error ? err.message : "Internal error";
									sendTo(ws, { type: "error", message: text });
								},
							);
							break;
						case "epic:cancel":
							handleEpicCancel();
							break;
						case "workflow:start-existing":
							handleStartExisting(ws, msg.workflowId);
							break;
						case "workflow:force-start":
							handleForceStart(ws, msg.workflowId);
							break;
						case "config:get":
							handleConfigGet(ws);
							break;
						case "config:save":
							handleConfigSave(ws, msg.config);
							break;
						case "config:reset":
							handleConfigReset(ws, msg.key);
							break;
						case "purge:all":
							handlePurgeAll().catch((err) => {
								const text = err instanceof Error ? err.message : "Purge failed";
								sendTo(ws, { type: "error", message: text });
							});
							break;
						default:
							sendTo(ws, { type: "error", message: "Unknown message type" });
					}
				} catch (err) {
					console.error("[ws] Message handling error:", err);
					sendTo(ws, { type: "error", message: "Invalid message format" });
				}
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
		console.log(`crab-studio running at http://localhost:${port}`);
		break;
	} catch (err) {
		if (i === MAX_PORT_RETRIES - 1) throw err;
		console.warn(`Port ${port} in use, trying ${port + 1}...`);
	}
}

// Restore persisted workflows on startup
(async () => {
	try {
		const allWorkflows = await sharedStore.loadAll();
		let restoredCount = 0;

		for (const workflow of allWorkflows) {
			// Skip terminal workflows — no orchestrator needed
			if (workflow.status === "completed" || workflow.status === "cancelled") {
				continue;
			}

			const orch = createOrchestrator();
			orch.getEngine().setWorkflow(workflow);

			// Resume previously-running workflows via --resume if session ID exists
			if (workflow.status === "running") {
				const runningStep = workflow.steps.find((s) => s.status === "running");

				// monitor-ci is direct code execution — restart polling from scratch
				if (runningStep?.name === "monitor-ci") {
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
					// No session ID — cannot resume, mark as error
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

		// Re-evaluate waiting_for_dependencies workflows whose deps may have completed while server was down
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
