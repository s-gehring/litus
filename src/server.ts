import type { ServerWebSocket } from "bun";
import { PipelineOrchestrator } from "./pipeline-orchestrator";
import { getMimeType, resolveStaticPath } from "./static-files";
import type { ClientMessage, PipelineStepName, ServerMessage, WorkflowState } from "./types";

type WsData = Record<string, never>;

const PORT = parseInt(process.env.PORT || "3000", 10);
const WS_TOPIC = "workflow";

const orchestrator = new PipelineOrchestrator({
	onStepChange: (workflowId, previousStep, currentStep, currentStepIndex, reviewIteration) => {
		broadcast({
			type: "workflow:step-change",
			workflowId,
			previousStep,
			currentStep,
			currentStepIndex,
			reviewIteration,
		});
	},
	onOutput: (workflowId, text) => {
		broadcast({ type: "workflow:output", workflowId, text });
	},
	onComplete: (workflowId) => {
		broadcastState();
	},
	onError: (workflowId, error) => {
		broadcastState();
	},
	onStateChange: (workflowId) => {
		broadcastState();
	},
});

function getWorkflowState(): WorkflowState | null {
	const w = orchestrator.getEngine().getWorkflow();
	if (!w) return null;
	const { sessionId: _, steps, ...rest } = w;
	return {
		...rest,
		steps: steps.map(({ sessionId: _sid, ...step }) => step),
	};
}

function broadcast(msg: ServerMessage) {
	server.publish(WS_TOPIC, JSON.stringify(msg));
}

function sendTo(ws: ServerWebSocket<WsData>, msg: ServerMessage) {
	ws.send(JSON.stringify(msg));
}

function broadcastState() {
	broadcast({ type: "workflow:state", workflow: getWorkflowState() });
}

async function handleStart(ws: ServerWebSocket<WsData>, specification: string) {
	if (!specification.trim()) {
		sendTo(ws, { type: "error", message: "Specification must be non-empty" });
		return;
	}

	const workflow = orchestrator.getEngine().getWorkflow();
	if (workflow && (workflow.status === "running" || workflow.status === "waiting_for_input")) {
		sendTo(ws, { type: "error", message: "A workflow is already active" });
		return;
	}

	try {
		await orchestrator.startPipeline(specification.trim());
		broadcastState();
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

	const workflow = orchestrator.getEngine().getWorkflow();
	if (!workflow || workflow.id !== workflowId) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	if (!workflow.pendingQuestion || workflow.pendingQuestion.id !== questionId) {
		sendTo(ws, { type: "error", message: "Question not found or already answered" });
		return;
	}

	orchestrator.answerQuestion(workflowId, questionId, answer.trim());
}

function handleSkip(ws: ServerWebSocket<WsData>, workflowId: string, questionId: string) {
	const workflow = orchestrator.getEngine().getWorkflow();
	if (!workflow || workflow.id !== workflowId) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	if (!workflow.pendingQuestion || workflow.pendingQuestion.id !== questionId) {
		sendTo(ws, { type: "error", message: "Question not found or already answered" });
		return;
	}

	orchestrator.skipQuestion(workflowId, questionId);
}

function handleCancel(ws: ServerWebSocket<WsData>, workflowId: string) {
	const workflow = orchestrator.getEngine().getWorkflow();
	if (!workflow || workflow.id !== workflowId) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	orchestrator.cancelPipeline(workflowId);
}

function handleRetry(ws: ServerWebSocket<WsData>, workflowId: string) {
	const workflow = orchestrator.getEngine().getWorkflow();
	if (!workflow || workflow.id !== workflowId) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	if (workflow.status !== "error") {
		sendTo(ws, { type: "error", message: "No failed step to retry" });
		return;
	}

	orchestrator.retryStep(workflowId);
}

const server = Bun.serve<WsData>({
	port: PORT,
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
			const workflow = orchestrator.getEngine().getWorkflow();
			const isActive =
				workflow && (workflow.status === "running" || workflow.status === "waiting_for_input");
			return Response.json({
				status: "ok",
				activeWorkflow: isActive ? workflow.id : null,
				currentStep: isActive ? workflow.steps[workflow.currentStepIndex]?.name ?? null : null,
				reviewIteration: isActive ? workflow.reviewCycle.iteration : null,
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
		open(ws: ServerWebSocket<WsData>) {
			ws.subscribe(WS_TOPIC);
			ws.send(
				JSON.stringify({
					type: "workflow:state",
					workflow: getWorkflowState(),
				} satisfies ServerMessage),
			);
		},
		message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
			try {
				const msg = JSON.parse(String(message)) as ClientMessage;

				switch (msg.type) {
					case "workflow:start":
						handleStart(ws, msg.specification).catch((err) => {
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

console.log(`crab-studio running at http://localhost:${PORT}`);
