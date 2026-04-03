import type { ClientMessage, ServerMessage } from "../types";
import { renderPipelineSteps } from "./components/pipeline-steps";
import { getAnswer, hideQuestion, showQuestion } from "./components/question-panel";
import {
	appendOutput,
	clearOutput,
	updateSummary,
	updateWorkflowStatus,
} from "./components/workflow-window";

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

let ws: WebSocket | null = null;
let currentWorkflowId: string | null = null;
let currentQuestionId: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function getWsUrl(): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/ws`;
}

function connect(): void {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
		return;
	}

	ws = new WebSocket(getWsUrl());

	ws.onopen = () => {
		const dot = $("#connection-status");
		dot.className = "status-dot connected";
		dot.title = "Connected";

		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	};

	ws.onclose = () => {
		const dot = $("#connection-status");
		dot.className = "status-dot disconnected";
		dot.title = "Disconnected";
		scheduleReconnect();
	};

	ws.onerror = () => {
		// onclose will fire after this
	};

	ws.onmessage = (event) => {
		try {
			const msg = JSON.parse(event.data) as ServerMessage;
			handleMessage(msg);
		} catch {
			// Ignore malformed messages
		}
	};
}

function scheduleReconnect(): void {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, 2000);
}

function send(msg: ClientMessage): void {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

function handleMessage(msg: ServerMessage): void {
	switch (msg.type) {
		case "workflow:state":
			if (msg.workflow) {
				currentWorkflowId = msg.workflow.id;
				if (msg.workflow.pendingQuestion) {
					currentQuestionId = msg.workflow.pendingQuestion.id;
					showQuestion(msg.workflow.pendingQuestion);
				} else {
					currentQuestionId = null;
					hideQuestion();
				}
				if (msg.workflow.summary) {
					updateSummary(msg.workflow.summary);
				}
			} else {
				currentWorkflowId = null;
				currentQuestionId = null;
				hideQuestion();
			}
			updateWorkflowStatus(msg.workflow);
			renderPipelineSteps(msg.workflow);
			break;

		case "workflow:output":
			appendOutput(msg.text);
			break;

		case "workflow:question":
			currentQuestionId = msg.question.id;
			showQuestion(msg.question);
			break;

		case "workflow:summary":
			updateSummary(msg.summary);
			break;

		case "workflow:step-change":
			// Clear output for new step
			clearOutput();
			appendOutput(`── Step: ${msg.currentStep} ──`, "system");
			break;

		case "error":
			appendOutput(`Error: ${msg.message}`, "error");
			break;
	}
}

// Wire up UI events
document.addEventListener("DOMContentLoaded", () => {
	const btnStart = $("#btn-start") as HTMLButtonElement;
	const btnCancel = $("#btn-cancel") as HTMLButtonElement;
	const btnRetry = document.getElementById("btn-retry") as HTMLButtonElement | null;
	const btnSubmitAnswer = $("#btn-submit-answer") as HTMLButtonElement;
	const btnSkip = $("#btn-skip-question") as HTMLButtonElement;
	const specInput = $("#specification-input") as HTMLTextAreaElement;

	btnStart.addEventListener("click", () => {
		const spec = specInput.value.trim();
		if (!spec) return;

		clearOutput();
		updateSummary("");
		send({ type: "workflow:start", specification: spec });
		btnStart.disabled = true;
	});

	btnCancel.addEventListener("click", () => {
		if (currentWorkflowId) {
			send({ type: "workflow:cancel", workflowId: currentWorkflowId });
		}
	});

	if (btnRetry) {
		btnRetry.addEventListener("click", () => {
			if (currentWorkflowId) {
				send({ type: "workflow:retry", workflowId: currentWorkflowId });
			}
		});
	}

	btnSubmitAnswer.addEventListener("click", () => {
		const answer = getAnswer();
		if (!answer || !currentWorkflowId || !currentQuestionId) return;

		send({
			type: "workflow:answer",
			workflowId: currentWorkflowId,
			questionId: currentQuestionId,
			answer,
		});
	});

	btnSkip.addEventListener("click", () => {
		if (!currentWorkflowId || !currentQuestionId) return;

		send({
			type: "workflow:skip",
			workflowId: currentWorkflowId,
			questionId: currentQuestionId,
		});
	});

	// Allow Enter to submit answer (Shift+Enter for newline)
	const answerInput = $("#answer-input") as HTMLTextAreaElement;
	answerInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			btnSubmitAnswer.click();
		}
	});

	// Allow Ctrl+Enter to start workflow
	specInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			btnStart.click();
		}
	});

	connect();
});
