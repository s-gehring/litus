import type { ServerWebSocket } from "bun";
import { AuditLogger } from "./audit-logger";
import { CLIRunner } from "./cli-runner";
import { PipelineOrchestrator } from "./pipeline-orchestrator";
import { QuestionDetector } from "./question-detector";
import { ReviewClassifier } from "./review-classifier";
import { getMimeType, resolveStaticPath } from "./static-files";
import { Summarizer } from "./summarizer";
import { validateTargetRepository } from "./target-repo-validator";
import type {
	ClientMessage,
	PipelineStepName,
	ServerMessage,
	Workflow,
	WorkflowState,
} from "./types";
import { WorkflowStore } from "./workflow-store";

type WsData = Record<string, never>;

const BASE_PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_PORT_RETRIES = 10;
const WS_TOPIC = "workflow";

// Shared dependencies across all orchestrator instances
const sharedStore = new WorkflowStore();
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
		onComplete: (workflowId: string) => {
			broadcastWorkflowState(workflowId);
			orchestrators.delete(workflowId);
		},
		onError: (workflowId: string, error: string) => {
			console.error(`[pipeline] Step error (${workflowId}): ${error}`);
			broadcast({ type: "error", message: error });
			broadcastWorkflowState(workflowId);
		},
		onStateChange: (workflowId: string) => {
			broadcastWorkflowState(workflowId);
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

	// Validate target repository if provided
	if (targetRepository) {
		const validation = await validateTargetRepository(targetRepository);
		if (!validation.valid) {
			sendTo(ws, { type: "error", message: validation.error ?? "Invalid target repository" });
			return;
		}
	}

	try {
		const orch = createOrchestrator();
		const workflow = await orch.startPipeline(specification.trim(), targetRepository);
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

function handleCancel(ws: ServerWebSocket<WsData>, workflowId: string) {
	const orch = orchestrators.get(workflowId);
	if (!orch) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	orch.cancelPipeline(workflowId);
	orchestrators.delete(workflowId);
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
						case "workflow:cancel":
							handleCancel(ws, msg.workflowId);
							break;
						case "workflow:retry":
							handleRetry(ws, msg.workflowId);
							break;
						default:
							sendTo(ws, { type: "error", message: "Unknown message type" });
					}
				} catch {
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
				if (runningStep?.sessionId) {
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
	} catch (err) {
		console.error(`[startup] Failed to restore workflows: ${err}`);
	}
})();
