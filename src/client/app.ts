import type {
	ClientMessage,
	OutputEntry,
	ServerMessage,
	WorkflowClientState,
	WorkflowState,
} from "../types";
import { renderPipelineSteps } from "./components/pipeline-steps";
import { getAnswer, hideQuestion, showQuestion } from "./components/question-panel";
import { renderCardStrip, updateTimers } from "./components/workflow-cards";
import {
	appendOutput,
	appendToolIcons,
	clearOutput,
	renderOutputEntries,
	updateFlavor,
	updateStepSummary,
	updateSummary,
	updateWorkflowStatus,
} from "./components/workflow-window";

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

const MAX_OUTPUT_LINES = 5000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Multi-workflow client state
const workflows = new Map<string, WorkflowClientState>();
const workflowOrder: string[] = [];
let expandedWorkflowId: string | null = null;

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

	ws.onerror = () => {};

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

function addOrUpdateWorkflow(wfState: WorkflowState): void {
	const existing = workflows.get(wfState.id);
	if (existing) {
		existing.state = wfState;
	} else {
		workflows.set(wfState.id, {
			state: wfState,
			outputLines: [],
			isExpanded: false,
		});
		if (!workflowOrder.includes(wfState.id)) {
			workflowOrder.push(wfState.id);
		}
	}
}

function handleMessage(msg: ServerMessage): void {
	switch (msg.type) {
		case "workflow:list": {
			// Initial sync: populate all workflows
			workflows.clear();
			workflowOrder.length = 0;
			for (const wf of msg.workflows) {
				addOrUpdateWorkflow(wf);
			}
			renderCards();
			// If there's exactly one active workflow, auto-expand it
			if (msg.workflows.length === 1) {
				expandWorkflow(msg.workflows[0].id);
			} else {
				renderExpandedView();
			}
			break;
		}

		case "workflow:created": {
			addOrUpdateWorkflow(msg.workflow);
			renderCards();
			expandWorkflow(msg.workflow.id);
			break;
		}

		case "workflow:state": {
			if (!msg.workflow) break;
			addOrUpdateWorkflow(msg.workflow);
			renderCards();
			if (expandedWorkflowId === msg.workflow.id) {
				renderExpandedView();
			}
			break;
		}

		case "workflow:output": {
			const entry = workflows.get(msg.workflowId);
			if (entry) {
				const outputEntry: OutputEntry = { kind: "text", text: msg.text };
				entry.outputLines.push(outputEntry);
				if (entry.outputLines.length > MAX_OUTPUT_LINES) {
					entry.outputLines.splice(0, entry.outputLines.length - MAX_OUTPUT_LINES);
				}
				if (expandedWorkflowId === msg.workflowId) {
					appendOutput(msg.text);
				}
			}
			break;
		}

		case "workflow:tools": {
			const entry = workflows.get(msg.workflowId);
			if (entry) {
				const outputEntry: OutputEntry = { kind: "tools", tools: msg.tools };
				entry.outputLines.push(outputEntry);
				if (entry.outputLines.length > MAX_OUTPUT_LINES) {
					entry.outputLines.splice(0, entry.outputLines.length - MAX_OUTPUT_LINES);
				}
				if (expandedWorkflowId === msg.workflowId) {
					appendToolIcons(msg.tools);
				}
			}
			break;
		}

		case "workflow:question": {
			const entry = workflows.get(msg.workflowId);
			if (entry) {
				entry.state.pendingQuestion = msg.question;
				renderCards();
				if (expandedWorkflowId === msg.workflowId) {
					showQuestion(msg.question);
				}
			}
			break;
		}

		case "workflow:step-change": {
			const entry = workflows.get(msg.workflowId);
			if (entry) {
				entry.state.currentStepIndex = msg.currentStepIndex;
				entry.state.reviewCycle.iteration = msg.reviewIteration;
				const stepText = `── Step: ${msg.currentStep} ──`;
				entry.outputLines.push({ kind: "text", text: stepText, type: "system" });
				renderCards();
				if (expandedWorkflowId === msg.workflowId) {
					clearOutput();
					appendOutput(stepText, "system");
				}
			}
			break;
		}

		case "error": {
			appendOutput(`Error: ${msg.message}`, "error");
			break;
		}
	}
}

function expandWorkflow(workflowId: string): void {
	if (expandedWorkflowId === workflowId) {
		// Toggle collapse
		expandedWorkflowId = null;
	} else {
		expandedWorkflowId = workflowId;
	}
	renderCards();
	renderExpandedView();
}

function renderCards(): void {
	renderCardStrip(workflowOrder, workflows, expandedWorkflowId, expandWorkflow);
}

function renderExpandedView(): void {
	const detailArea = $("#detail-area");
	const welcomeArea = $("#welcome-area");

	if (!expandedWorkflowId) {
		// No workflow expanded — show welcome or empty state
		if (detailArea) detailArea.classList.add("hidden");
		if (welcomeArea) welcomeArea.classList.remove("hidden");
		hideQuestion();
		updateWorkflowStatus(null);
		renderPipelineSteps(null);
		updateSummary("");
		updateFlavor("");
		return;
	}

	if (welcomeArea) welcomeArea.classList.add("hidden");
	if (detailArea) detailArea.classList.remove("hidden");

	const entry = workflows.get(expandedWorkflowId);
	if (!entry) return;

	const wf = entry.state;

	// Render status, pipeline, summary
	updateWorkflowStatus(wf);
	renderPipelineSteps(wf);
	if (wf.summary) updateSummary(wf.summary);
	updateStepSummary(wf.stepSummary ?? "");
	updateFlavor(wf.flavor ?? "");

	// Render output from accumulated entries
	clearOutput();
	if (entry.outputLines.length > 0) {
		renderOutputEntries(entry.outputLines);
	} else if (wf.status === "error") {
		// Restored error workflows have no live output — show step error/output
		const errorStep = wf.steps.find((s) => s.status === "error");
		if (errorStep) {
			if (errorStep.output) {
				const trimmed =
					errorStep.output.length > 1000 ? `...${errorStep.output.slice(-1000)}` : errorStep.output;
				appendOutput(trimmed);
			}
			if (errorStep.error) {
				appendOutput(`Error: ${errorStep.error}`, "error");
			}
		}
	}

	// Question
	const isTerminal =
		wf.status === "cancelled" || wf.status === "completed" || wf.status === "error";
	if (wf.pendingQuestion && !isTerminal) {
		showQuestion(wf.pendingQuestion);
	} else {
		hideQuestion();
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
	const targetRepoInput = $("#target-repo-input") as HTMLInputElement;

	btnStart.addEventListener("click", () => {
		const spec = specInput.value.trim();
		if (!spec) return;

		const targetRepo = targetRepoInput.value.trim();
		send({
			type: "workflow:start",
			specification: spec,
			...(targetRepo ? { targetRepository: targetRepo } : {}),
		});
		specInput.value = "";
	});

	btnCancel.addEventListener("click", () => {
		if (expandedWorkflowId) {
			send({ type: "workflow:cancel", workflowId: expandedWorkflowId });
		}
	});

	if (btnRetry) {
		btnRetry.addEventListener("click", () => {
			if (expandedWorkflowId) {
				send({ type: "workflow:retry", workflowId: expandedWorkflowId });
			}
		});
	}

	btnSubmitAnswer.addEventListener("click", () => {
		const answer = getAnswer();
		if (!answer || !expandedWorkflowId) return;

		const entry = workflows.get(expandedWorkflowId);
		if (!entry?.state.pendingQuestion) return;

		send({
			type: "workflow:answer",
			workflowId: expandedWorkflowId,
			questionId: entry.state.pendingQuestion.id,
			answer,
		});
	});

	btnSkip.addEventListener("click", () => {
		if (!expandedWorkflowId) return;

		const entry = workflows.get(expandedWorkflowId);
		if (!entry?.state.pendingQuestion) return;

		send({
			type: "workflow:skip",
			workflowId: expandedWorkflowId,
			questionId: entry.state.pendingQuestion.id,
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

	// Timer update interval
	setInterval(updateTimers, 1000);

	connect();
});
