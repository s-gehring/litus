import type { ServerWebSocket } from "bun";
import { CLIRunner } from "./cli-runner";
import { QuestionDetector } from "./question-detector";
import { getMimeType, resolveStaticPath } from "./static-files";
import { Summarizer } from "./summarizer";
import type { ClientMessage, ServerMessage, WorkflowState } from "./types";
import { WorkflowEngine } from "./workflow-engine";

type WsData = Record<string, never>;

const PORT = parseInt(process.env.PORT || "3000", 10);
const WS_TOPIC = "workflow";

const engine = new WorkflowEngine();
const cliRunner = new CLIRunner();
const questionDetector = new QuestionDetector();
const summarizer = new Summarizer();

// Accumulated assistant text for question detection (CR-004)
let assistantTextBuffer = "";

function getWorkflowState(): WorkflowState | null {
	const w = engine.getWorkflow();
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

function cleanupWorkflow(workflowId: string) {
	cliRunner.kill(workflowId);
	summarizer.cleanup(workflowId);
	questionDetector.reset();
	assistantTextBuffer = "";
}

async function handleStart(ws: ServerWebSocket<WsData>, specification: string) {
	if (!specification.trim()) {
		sendTo(ws, { type: "error", message: "Specification must be non-empty" });
		return;
	}

	const workflow = engine.getWorkflow();
	if (workflow && (workflow.status === "running" || workflow.status === "waiting_for_input")) {
		sendTo(ws, { type: "error", message: "A workflow is already active" });
		return;
	}

	// Clean up previous workflow resources if any (CR-009)
	if (workflow) {
		cleanupWorkflow(workflow.id);
	}

	try {
		const w = await engine.createWorkflow(specification.trim());
		engine.transition(w.id, "running");
		broadcastState();

		cliRunner.start(w, {
			onOutput: (text) => {
				engine.updateLastOutput(w.id, text);
				broadcast({ type: "workflow:output", workflowId: w.id, text });

				// Accumulate text for question detection (CR-004)
				assistantTextBuffer += `${text}\n`;
				if (assistantTextBuffer.length > 500) {
					const bufferSnapshot = assistantTextBuffer;
					// CR2-003: Retain trailing text for cross-boundary detection
					assistantTextBuffer = assistantTextBuffer.slice(-200);

					const question = questionDetector.detect(bufferSnapshot);
					if (question) {
						// CR2-001: Use Haiku fallback for uncertain detections
						if (question.confidence === "uncertain") {
							questionDetector
								.classifyWithHaiku(question.content)
								.then((isQuestion) => {
									if (!isQuestion) return;
									// CR3-002: Guard against stale workflow state after async Haiku call
									const current = engine.getWorkflow();
									if (!current || current.id !== w.id || current.status !== "running") return;
									try {
										engine.setQuestion(w.id, question);
										engine.transition(w.id, "waiting_for_input");
										broadcast({ type: "workflow:question", workflowId: w.id, question });
										broadcastState();
									} catch {
										// Workflow may have ended
									}
								})
								.catch(() => {});
						} else {
							try {
								engine.setQuestion(w.id, question);
								engine.transition(w.id, "waiting_for_input");
								broadcast({ type: "workflow:question", workflowId: w.id, question });
								broadcastState();
							} catch {
								// Transition may fail if workflow already ended
							}
						}
					}
				}

				// Trigger summary generation periodically
				summarizer.maybeSummarize(w.id, text, (summary) => {
					try {
						engine.updateSummary(w.id, summary);
						broadcast({ type: "workflow:summary", workflowId: w.id, summary });
						broadcastState();
					} catch {
						// Workflow may have ended
					}
				});
			},
			onComplete: () => {
				try {
					engine.transition(w.id, "completed");
				} catch {
					// Already in terminal state
				}
				broadcastState();
				cleanupWorkflow(w.id);
			},
			onError: (error) => {
				engine.updateLastOutput(w.id, error);
				try {
					engine.transition(w.id, "error");
				} catch {
					// Already in terminal state
				}
				broadcastState();
				cleanupWorkflow(w.id);
			},
			onSessionId: (sessionId) => {
				engine.setSessionId(w.id, sessionId);
			},
		});
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

	const workflow = engine.getWorkflow();
	if (!workflow || workflow.id !== workflowId) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	if (!workflow.pendingQuestion || workflow.pendingQuestion.id !== questionId) {
		sendTo(ws, { type: "error", message: "Question not found or already answered" });
		return;
	}

	engine.clearQuestion(workflowId);
	try {
		engine.transition(workflowId, "running");
	} catch {
		// Race condition — workflow may have ended
	}
	broadcastState();

	cliRunner.sendAnswer(workflowId, answer.trim());
}

function handleSkip(ws: ServerWebSocket<WsData>, workflowId: string, questionId: string) {
	const workflow = engine.getWorkflow();
	if (!workflow || workflow.id !== workflowId) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	if (!workflow.pendingQuestion || workflow.pendingQuestion.id !== questionId) {
		sendTo(ws, { type: "error", message: "Question not found or already answered" });
		return;
	}

	engine.clearQuestion(workflowId);
	try {
		engine.transition(workflowId, "running");
	} catch {
		// Race condition
	}
	broadcastState();

	cliRunner.sendAnswer(
		workflowId,
		"The user has chosen not to answer this question. Continue with your best judgment.",
	);
}

function handleCancel(ws: ServerWebSocket<WsData>, workflowId: string) {
	const workflow = engine.getWorkflow();
	if (!workflow || workflow.id !== workflowId) {
		sendTo(ws, { type: "error", message: "Workflow not found" });
		return;
	}

	cleanupWorkflow(workflowId);
	try {
		engine.transition(workflowId, "cancelled");
	} catch {
		// Already in terminal state
	}
	broadcastState();
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
			const workflow = engine.getWorkflow();
			return Response.json({
				status: "ok",
				activeWorkflow:
					workflow && (workflow.status === "running" || workflow.status === "waiting_for_input")
						? workflow.id
						: null,
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
			// Send current state on connect
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
						// CR-005: catch async rejections
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
