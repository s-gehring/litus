import type {
	ClientMessage,
	EpicAggregatedState,
	EpicClientState,
	OutputEntry,
	ServerMessage,
	WorkflowClientState,
	WorkflowState,
} from "../types";
import { createConfigPanel, updateConfigPanel } from "./components/config-panel";
import { createEpicForm, hideEpicForm, showEpicForm } from "./components/epic-form";
import { renderEpicTree } from "./components/epic-tree";
import { renderPipelineSteps } from "./components/pipeline-steps";
import { getAnswer, hideQuestion, showQuestion } from "./components/question-panel";
import { EPIC_AGG_STATUS_CLASSES, EPIC_CARD_PREFIX } from "./components/status-maps";
import { renderCardStrip, updateTimers } from "./components/workflow-cards";
import {
	appendOutput,
	appendToolIcons,
	clearOutput,
	renderOutputEntries,
	updateDetailActions,
	updateEpicStatus,
	updateFlavor,
	updateSpecDetails,
	updateStepSummary,
	updateSummary,
	updateWorkflowStatus,
} from "./components/workflow-window";
import { computeEpicAggregatedState } from "./epic-aggregation";

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

let maxOutputLines = 5000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Multi-workflow client state
const workflows = new Map<string, WorkflowClientState>();
const epics = new Map<string, EpicClientState>();
const cardOrder: string[] = [];
let expandedId: string | null = null;

// Epic tree state
let expandedEpicId: string | null = null;
let selectedChildId: string | null = null;
const epicAggregates = new Map<string, EpicAggregatedState>();

function rebuildEpicAggregates(): void {
	epicAggregates.clear();

	// Group workflows by epicId
	const epicGroups = new Map<string, WorkflowState[]>();
	for (const [, entry] of workflows) {
		const wf = entry.state;
		if (wf.epicId) {
			if (!epicGroups.has(wf.epicId)) epicGroups.set(wf.epicId, []);
			epicGroups.get(wf.epicId)?.push(wf);
		}
	}

	for (const [epicId, children] of epicGroups) {
		const agg = computeEpicAggregatedState(children);
		if (agg) epicAggregates.set(epicId, agg);
	}
}

function rebuildCardOrder(): void {
	cardOrder.length = 0;
	const seenEpics = new Set<string>();

	// Collect all items with their sort keys
	const items: { key: string; sortDate: string }[] = [];

	for (const [, entry] of workflows) {
		const wf = entry.state;
		if (wf.epicId) {
			if (!seenEpics.has(wf.epicId)) {
				seenEpics.add(wf.epicId);
				const agg = epicAggregates.get(wf.epicId);
				items.push({
					key: `${EPIC_CARD_PREFIX}${wf.epicId}`,
					sortDate: agg?.startDate ?? wf.createdAt,
				});
			}
		} else {
			items.push({ key: wf.id, sortDate: wf.createdAt });
		}
	}

	// Also include active epic analysis cards (not yet completed with children)
	for (const [epicId, epic] of epics) {
		if (epic.status === "analyzing" || (epic.status === "error" && !seenEpics.has(epicId))) {
			items.push({ key: epicId, sortDate: epic.startedAt });
		}
	}

	// Sort by date ascending
	items.sort((a, b) => a.sortDate.localeCompare(b.sortDate));
	for (const item of items) {
		cardOrder.push(item.key);
	}
}

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

		send({ type: "config:get" });
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
		if (!cardOrder.includes(wfState.id)) {
			cardOrder.push(wfState.id);
		}
	}
}

function handleMessage(msg: ServerMessage): void {
	switch (msg.type) {
		case "workflow:list": {
			// Initial sync: populate all workflows
			workflows.clear();
			for (const wf of msg.workflows) {
				addOrUpdateWorkflow(wf);
			}
			rebuildEpicAggregates();
			rebuildCardOrder();
			renderCards();
			// If there's exactly one non-epic workflow, auto-expand it
			const standaloneWorkflows = msg.workflows.filter((w) => !w.epicId);
			if (standaloneWorkflows.length === 1 && epicAggregates.size === 0) {
				expandItem(standaloneWorkflows[0].id);
			} else if (epicAggregates.size === 1 && standaloneWorkflows.length === 0) {
				const epicId = [...epicAggregates.keys()][0];
				expandItem(`${EPIC_CARD_PREFIX}${epicId}`);
			} else {
				renderExpandedView();
			}
			break;
		}

		case "workflow:created": {
			addOrUpdateWorkflow(msg.workflow);
			if (msg.workflow.epicId) {
				rebuildEpicAggregates();
				rebuildCardOrder();
			} else if (!cardOrder.includes(msg.workflow.id)) {
				cardOrder.push(msg.workflow.id);
			}
			renderCards();
			// Don't auto-expand child workflows while viewing the epic analysis
			if (!epics.has(expandedId ?? "") && !msg.workflow.epicId) {
				expandItem(msg.workflow.id);
			}
			// If viewing the epic's tree, re-render it
			if (expandedEpicId && msg.workflow.epicId === expandedEpicId) {
				renderExpandedView();
			}
			break;
		}

		case "workflow:state": {
			if (!msg.workflow) break;
			addOrUpdateWorkflow(msg.workflow);
			// Recompute epic aggregate if child changed
			if (msg.workflow.epicId) {
				rebuildEpicAggregates();
			}
			renderCards();
			if (expandedId === msg.workflow.id) {
				renderExpandedView();
			}
			// If the epic tree is displayed and this is a child, re-render tree
			if (expandedEpicId && msg.workflow.epicId === expandedEpicId) {
				renderExpandedView();
			}
			break;
		}

		case "workflow:output": {
			const entry = workflows.get(msg.workflowId);
			if (entry) {
				const outputEntry: OutputEntry = { kind: "text", text: msg.text };
				entry.outputLines.push(outputEntry);
				if (entry.outputLines.length > maxOutputLines) {
					entry.outputLines.splice(0, entry.outputLines.length - maxOutputLines);
				}
				if (expandedId === msg.workflowId) {
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
				if (entry.outputLines.length > maxOutputLines) {
					entry.outputLines.splice(0, entry.outputLines.length - maxOutputLines);
				}
				if (expandedId === msg.workflowId) {
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
				if (expandedId === msg.workflowId) {
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
				if (expandedId === msg.workflowId) {
					clearOutput();
					appendOutput(stepText, "system");
				}
			}
			break;
		}

		case "epic:created": {
			hideEpicForm();
			epics.set(msg.epicId, {
				epicId: msg.epicId,
				description: msg.description,
				status: "analyzing",
				title: null,
				outputLines: [],
				workflowIds: [],
				startedAt: new Date().toISOString(),
				completedAt: null,
				errorMessage: null,
			});
			cardOrder.push(msg.epicId);
			renderCards();
			expandItem(msg.epicId);
			break;
		}

		case "epic:summary": {
			const epic = epics.get(msg.epicId);
			if (epic) {
				epic.title = msg.summary;
				renderCards();
				if (expandedId === msg.epicId) {
					updateSummary(msg.summary);
				}
			}
			break;
		}

		case "epic:output": {
			const epic = epics.get(msg.epicId);
			if (epic) {
				epic.outputLines.push({ kind: "text", text: msg.text });
				if (epic.outputLines.length > maxOutputLines) {
					epic.outputLines.splice(0, epic.outputLines.length - maxOutputLines);
				}
				if (expandedId === msg.epicId) {
					appendOutput(msg.text);
				}
			}
			break;
		}

		case "epic:tools": {
			const epic = epics.get(msg.epicId);
			if (epic) {
				epic.outputLines.push({ kind: "tools", tools: msg.tools });
				if (epic.outputLines.length > maxOutputLines) {
					epic.outputLines.splice(0, epic.outputLines.length - maxOutputLines);
				}
				if (expandedId === msg.epicId) {
					appendToolIcons(msg.tools);
				}
			}
			break;
		}

		case "epic:result": {
			const epic = epics.get(msg.epicId);
			if (epic) {
				epic.status = "completed";
				epic.completedAt = new Date().toISOString();
				epic.title = msg.title;
				epic.workflowIds = msg.workflowIds;
				// Rebuild aggregates and card order to transition from analysis card to epic card
				rebuildEpicAggregates();
				rebuildCardOrder();
				renderCards();
				// Auto-expand the epic tree
				if (expandedId === msg.epicId) {
					expandItem(`${EPIC_CARD_PREFIX}${msg.epicId}`);
				}
			}
			break;
		}

		case "epic:error": {
			const epic = epics.get(msg.epicId);
			if (epic) {
				epic.status = "error";
				epic.completedAt = new Date().toISOString();
				epic.errorMessage = msg.message;
				epic.outputLines.push({ kind: "text", text: `Error: ${msg.message}`, type: "error" });
				renderCards();
				if (expandedId === msg.epicId) {
					appendOutput(`Error: ${msg.message}`, "error");
				}
			}
			break;
		}

		case "epic:dependency-update": {
			const entry = workflows.get(msg.workflowId);
			if (entry) {
				entry.state.epicDependencyStatus = msg.epicDependencyStatus;
				renderCards();
				if (expandedId === msg.workflowId) {
					renderExpandedView();
				}
				// Re-render epic tree if this child's epic is displayed
				if (expandedEpicId && entry.state.epicId === expandedEpicId) {
					renderExpandedView();
				}
			}
			break;
		}

		case "config:state": {
			updateConfigPanel(msg.config, msg.warnings);
			if (msg.config.timing?.maxClientOutputLines) {
				maxOutputLines = msg.config.timing.maxClientOutputLines;
			}
			break;
		}

		case "config:error": {
			// Show first error as output
			if (msg.errors.length > 0) {
				appendOutput(`Config error: ${msg.errors[0].path} — ${msg.errors[0].message}`, "error");
			}
			break;
		}

		case "error": {
			appendOutput(`Error: ${msg.message}`, "error");
			break;
		}
	}
}

function expandItem(id: string): void {
	// Check if it's an epic card (epic:{epicId})
	if (id.startsWith(EPIC_CARD_PREFIX)) {
		const epicId = id.slice(EPIC_CARD_PREFIX.length);
		if (expandedEpicId === epicId && !selectedChildId) {
			// Toggle collapse
			expandedEpicId = null;
			expandedId = null;
		} else {
			expandedEpicId = epicId;
			selectedChildId = null;
			expandedId = id;
		}
	} else {
		// Regular workflow or epic analysis
		if (expandedId === id) {
			expandedId = null;
			expandedEpicId = null;
			selectedChildId = null;
		} else {
			expandedId = id;
			expandedEpicId = null;
			selectedChildId = null;
		}
	}
	renderCards();
	renderExpandedView();
}

function selectChild(workflowId: string): void {
	if (selectedChildId === workflowId) {
		// Deselect: go back to tree
		selectedChildId = null;
	} else {
		selectedChildId = workflowId;
	}
	renderExpandedView();
}

function returnToEpicTree(): void {
	selectedChildId = null;
	renderExpandedView();
}

function renderCards(): void {
	renderCardStrip(cardOrder, workflows, epics, epicAggregates, expandedId, expandItem);
}

function renderExpandedView(): void {
	const detailArea = $("#detail-area");
	const welcomeArea = $("#welcome-area");
	const treeContainer = document.getElementById("epic-tree-panel");

	// Clear tree panel and breadcrumb if they exist
	if (treeContainer) treeContainer.remove();
	const existingBreadcrumb = document.getElementById("epic-breadcrumb");
	if (existingBreadcrumb) existingBreadcrumb.remove();

	if (!expandedId) {
		// Nothing expanded — show welcome
		if (detailArea) detailArea.classList.add("hidden");
		if (welcomeArea) welcomeArea.classList.remove("hidden");
		hideQuestion();
		updateWorkflowStatus(null);
		renderPipelineSteps(null);
		updateSummary("");
		updateFlavor("");
		updateSpecDetails("");
		updateDetailActions([]);
		return;
	}

	// Check if expanded item is an epic analysis card
	const epic = epics.get(expandedId);
	if (epic && !expandedId.startsWith(EPIC_CARD_PREFIX)) {
		if (welcomeArea) welcomeArea.classList.add("hidden");
		if (detailArea) detailArea.classList.remove("hidden");

		updateEpicStatus(epic.status);
		renderPipelineSteps(null);
		updateSummary(epic.title || epic.description);
		updateStepSummary("");
		updateFlavor("");
		updateSpecDetails(epic.description);
		updateDetailActions([]);
		hideQuestion();

		clearOutput();
		if (epic.outputLines.length > 0) {
			renderOutputEntries(epic.outputLines);
		}
		return;
	}

	// Check if it's an aggregated epic card
	if (expandedEpicId) {
		const agg = epicAggregates.get(expandedEpicId);
		if (!agg) return;

		if (welcomeArea) welcomeArea.classList.add("hidden");
		if (detailArea) detailArea.classList.remove("hidden");

		// If a child is selected, show the child's detail view with breadcrumb
		if (selectedChildId) {
			renderChildDetailView(selectedChildId, agg);
			return;
		}

		// Show epic tree view
		renderEpicTreeView(agg);
		return;
	}

	// Regular workflow
	if (welcomeArea) welcomeArea.classList.add("hidden");
	if (detailArea) detailArea.classList.remove("hidden");

	const entry = workflows.get(expandedId);
	if (!entry) return;

	renderWorkflowDetail(entry);
}

function renderEpicTreeView(agg: EpicAggregatedState): void {
	// Update status area for epic
	const statusBadge = $("#workflow-status");
	statusBadge.textContent = agg.status;
	statusBadge.className = `status-badge ${EPIC_AGG_STATUS_CLASSES[agg.status] || "card-status-idle"}`;

	renderPipelineSteps(null);
	updateSummary(`${agg.title} (${agg.progress.completed}/${agg.progress.total} completed)`);
	updateStepSummary("");
	updateFlavor("");
	updateSpecDetails("");
	updateDetailActions([]);
	hideQuestion();
	clearOutput();

	// Hide the step history and spec details
	const stepHistory = $("#step-history");
	if (stepHistory) stepHistory.replaceChildren();

	// Build workflow map from child IDs
	const childWorkflows = new Map<string, WorkflowState>();
	for (const id of agg.childWorkflowIds) {
		const entry = workflows.get(id);
		if (entry) childWorkflows.set(id, entry.state);
	}

	// Render the tree inside the output area
	const outputLog = $("#output-log");
	outputLog.replaceChildren();

	const tree = renderEpicTree(agg, childWorkflows, selectChild);
	outputLog.appendChild(tree);
}

function renderChildDetailView(childId: string, epicAgg: EpicAggregatedState): void {
	const entry = workflows.get(childId);
	if (!entry) return;

	renderWorkflowDetail(entry, epicAgg);
}

function renderWorkflowDetail(entry: WorkflowClientState, epicContext?: EpicAggregatedState): void {
	const wf = entry.state;

	// Render status, pipeline, summary
	updateWorkflowStatus(wf);
	renderPipelineSteps(wf);
	if (wf.summary) updateSummary(wf.summary);
	updateStepSummary(wf.stepSummary ?? "");
	updateFlavor(wf.flavor ?? "");
	updateSpecDetails(wf.specification);

	// Action buttons for idle/waiting epic workflows
	const actions: { label: string; className: string; onClick: () => void }[] = [];
	if (wf.status === "idle" && wf.epicId) {
		actions.push({
			label: "Start",
			className: "btn-primary",
			onClick: () => send({ type: "workflow:start-existing", workflowId: wf.id }),
		});
	}
	if (wf.status === "waiting_for_dependencies") {
		actions.push({
			label: "Force Start",
			className: "btn-secondary",
			onClick: () => send({ type: "workflow:force-start", workflowId: wf.id }),
		});
	}
	updateDetailActions(actions);

	// Render output from accumulated entries
	clearOutput();

	// Add breadcrumb before the output area (outside scrollable container) if viewing within an epic context
	if (epicContext) {
		const outputArea = document.getElementById("output-area");
		if (outputArea) {
			const breadcrumb = document.createElement("div");
			breadcrumb.className = "epic-breadcrumb";
			breadcrumb.id = "epic-breadcrumb";
			breadcrumb.textContent = `\u2190 Epic: ${epicContext.title}`;
			breadcrumb.addEventListener("click", returnToEpicTree);
			outputArea.parentElement?.insertBefore(breadcrumb, outputArea);
		}
	}

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
		if (expandedId) {
			send({ type: "workflow:cancel", workflowId: expandedId });
		}
	});

	if (btnRetry) {
		btnRetry.addEventListener("click", () => {
			if (expandedId) {
				send({ type: "workflow:retry", workflowId: expandedId });
			}
		});
	}

	btnSubmitAnswer.addEventListener("click", () => {
		const answer = getAnswer();
		if (!answer || !expandedId) return;

		const entry = workflows.get(expandedId);
		if (!entry?.state.pendingQuestion) return;

		send({
			type: "workflow:answer",
			workflowId: expandedId,
			questionId: entry.state.pendingQuestion.id,
			answer,
		});
	});

	btnSkip.addEventListener("click", () => {
		if (!expandedId) return;

		const entry = workflows.get(expandedId);
		if (!entry?.state.pendingQuestion) return;

		send({
			type: "workflow:skip",
			workflowId: expandedId,
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

	// Epic form
	const epicForm = createEpicForm(send, () => targetRepoInput.value.trim());
	const inputArea = document.getElementById("input-area");
	if (inputArea) inputArea.parentElement?.insertBefore(epicForm, inputArea);

	const btnEpic = document.getElementById("btn-epic");
	if (btnEpic) {
		btnEpic.addEventListener("click", () => showEpicForm());
	}

	// Config panel
	const configPanel = createConfigPanel(send);
	const configContainer = document.getElementById("config-panel");
	if (configContainer) configContainer.appendChild(configPanel);

	const btnConfig = document.getElementById("btn-config");
	if (btnConfig) {
		btnConfig.addEventListener("click", () => {
			const panel = document.getElementById("config-panel");
			if (panel) {
				panel.classList.toggle("hidden");
				if (!panel.classList.contains("hidden")) {
					send({ type: "config:get" });
				}
			}
		});
	}

	// Timer update interval
	setInterval(updateTimers, 1000);

	connect();
});
