import { marked } from "marked";
import type {
	ClientMessage,
	EpicAggregatedState,
	EpicClientState,
	OutputEntry,
	ServerMessage,
	WorkflowClientState,
	WorkflowState,
} from "../types";
import {
	createConfigPanel,
	hideConfigPanel,
	showConfigPanel,
	updateConfigPanel,
} from "./components/config-panel";
import { createModal } from "./components/creation-modal";
import { renderEpicTree } from "./components/epic-tree";
import { createFolderPicker } from "./components/folder-picker";
import { renderPipelineSteps } from "./components/pipeline-steps";
import { getAnswer, hideQuestion, showQuestion } from "./components/question-panel";
import { EPIC_AGG_STATUS_CLASSES, EPIC_CARD_PREFIX } from "./components/status-maps";
import { renderCardStrip, updateTimers } from "./components/workflow-cards";
import {
	appendOutput,
	appendToolIcons,
	clearOutput,
	renderOutputEntries,
	updateBranchInfo,
	updateDetailActions,
	updateEpicStatus,
	updateFlavor,
	updateSpecDetails,
	updateStepSummary,
	updateSummary,
	updateUserInput,
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
let selectedStepIndex: number | null = null;

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

	// Also include epic analysis cards without children (analyzing, error, infeasible)
	for (const [epicId, epic] of epics) {
		if (!seenEpics.has(epicId) && epic.workflowIds.length === 0) {
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
				if (expandedId === msg.workflowId && selectedStepIndex === entry.state.currentStepIndex) {
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
				if (expandedId === msg.workflowId && selectedStepIndex === entry.state.currentStepIndex) {
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
				const wasWatchingRunning = selectedStepIndex === entry.state.currentStepIndex;
				entry.state.currentStepIndex = msg.currentStepIndex;
				entry.state.reviewCycle.iteration = msg.reviewIteration;
				const stepText = `── Step: ${msg.currentStep} ──`;
				entry.outputLines = [{ kind: "text", text: stepText, type: "system" }];
				renderCards();
				if (expandedId === msg.workflowId) {
					// If user was watching the running step, auto-select the new running step
					if (wasWatchingRunning) {
						selectStep(msg.currentStepIndex);
					} else {
						// Re-render pipeline to update step statuses
						renderPipelineSteps(entry.state, selectedStepIndex, selectStep);
					}
				}
			}
			break;
		}

		case "epic:list": {
			for (const pe of msg.epics) {
				if (!epics.has(pe.epicId)) {
					epics.set(pe.epicId, { ...pe, outputLines: [] });
					// Infeasible/error epics without children need their own card
					if (pe.workflowIds.length === 0 && !cardOrder.includes(pe.epicId)) {
						cardOrder.push(pe.epicId);
					}
				}
			}
			rebuildEpicAggregates();
			rebuildCardOrder();
			renderCards();
			renderExpandedView();
			break;
		}

		case "epic:created": {
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
				infeasibleNotes: null,
				analysisSummary: null,
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
				epic.analysisSummary = msg.summary;
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

		case "epic:infeasible": {
			const epic = epics.get(msg.epicId);
			if (epic) {
				epic.status = "infeasible";
				epic.completedAt = new Date().toISOString();
				epic.title = msg.title;
				epic.infeasibleNotes = msg.infeasibleNotes;
				renderCards();
				if (expandedId === msg.epicId) {
					renderExpandedView();
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

		case "log": {
			appendOutput(msg.text, "system");
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
			selectedStepIndex = null;
		} else {
			expandedEpicId = epicId;
			selectedChildId = null;
			expandedId = id;
			selectedStepIndex = null;
		}
	} else {
		// Regular workflow or epic analysis
		if (expandedId === id) {
			expandedId = null;
			expandedEpicId = null;
			selectedChildId = null;
			selectedStepIndex = null;
		} else {
			expandedId = id;
			expandedEpicId = null;
			selectedChildId = null;
			selectedStepIndex = null;
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
	selectedStepIndex = null;
	renderExpandedView();
}

function returnToEpicTree(): void {
	selectedChildId = null;
	selectedStepIndex = null;
	renderExpandedView();
}

function renderCards(): void {
	renderCardStrip(cardOrder, workflows, epics, epicAggregates, expandedId, expandItem);
}

function renderExpandedView(): void {
	const detailArea = $("#detail-area");
	const welcomeArea = $("#welcome-area");
	const treeContainer = document.getElementById("epic-tree-panel");

	// Clear tree panel, breadcrumb, analysis details, and fullsize mode
	if (treeContainer) treeContainer.remove();
	const existingBreadcrumb = document.getElementById("epic-breadcrumb");
	if (existingBreadcrumb) existingBreadcrumb.remove();
	const existingAnalysis = document.getElementById("epic-analysis-notes");
	if (existingAnalysis) existingAnalysis.remove();
	const outputArea = document.getElementById("output-area");
	if (outputArea) outputArea.classList.remove("epic-tree-fullsize");

	if (!expandedId) {
		// Nothing expanded — show welcome
		if (detailArea) detailArea.classList.add("hidden");
		if (welcomeArea) welcomeArea.classList.remove("hidden");
		hideQuestion();
		updateWorkflowStatus(null);
		updateBranchInfo(null);
		renderPipelineSteps(null);
		updateSummary("");
		updateFlavor("");
		updateUserInput("");
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
		updateUserInput(epic.description);
		updateSpecDetails("");
		updateDetailActions([]);
		hideQuestion();

		// Make output area fill available space for epic analysis
		const oa = $("#output-area");
		oa.classList.add("epic-tree-fullsize");

		clearOutput();
		if (epic.status === "infeasible" && epic.infeasibleNotes) {
			// Render infeasible notes as markdown inside the output log
			const outputLog = $("#output-log");
			const notesEl = document.createElement("div");
			notesEl.className = "user-input epic-analysis-notes infeasible-notes-fullheight";
			notesEl.innerHTML = marked.parse(epic.infeasibleNotes) as string;
			outputLog.appendChild(notesEl);
		} else if (epic.outputLines.length > 0) {
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
	updateDetailActions([]);
	hideQuestion();
	clearOutput();
	updateSpecDetails("");

	// Show epic description and analysis output
	const epicData = epics.get(agg.epicId);
	if (epicData) {
		updateUserInput(epicData.description);
		renderEpicAnalysisNotes(epicData);
	} else {
		updateUserInput("");
	}

	// Make output area fill available space for epic tree
	const outputArea = $("#output-area");
	outputArea.classList.add("epic-tree-fullsize");

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

function renderEpicAnalysisNotes(epicData: EpicClientState): void {
	// Remove existing if present
	const existing = document.getElementById("epic-analysis-notes");
	if (existing) existing.remove();

	// Prefer the LLM-generated summary; fall back to infeasibleNotes
	const content = epicData.analysisSummary || epicData.infeasibleNotes;
	if (!content) return;

	const container = document.createElement("div");
	container.id = "epic-analysis-notes";
	container.className = "epic-analysis-notes user-input";
	container.innerHTML = marked.parse(content) as string;

	// Insert after user-input
	const userInput = document.getElementById("user-input");
	if (userInput) {
		userInput.parentElement?.insertBefore(container, userInput.nextSibling);
	}
}

function renderChildDetailView(childId: string, epicAgg: EpicAggregatedState): void {
	const entry = workflows.get(childId);
	if (!entry) return;

	renderWorkflowDetail(entry, epicAgg);
}

function selectStep(index: number): void {
	const workflowId = selectedChildId ?? expandedId;
	const entry = workflowId ? workflows.get(workflowId) : null;
	if (!entry) return;

	selectedStepIndex = index;
	const wf = entry.state;
	const step = wf.steps[index];
	if (!step) return;

	clearOutput();

	if (
		index === wf.currentStepIndex &&
		(wf.status === "running" || wf.status === "waiting_for_input")
	) {
		// Show live accumulated output
		if (entry.outputLines.length > 0) {
			renderOutputEntries(entry.outputLines);
		}
	} else if (step.output || step.error) {
		// Show stored step output
		if (step.output) appendOutput(step.output);
		if (step.error) appendOutput(`Error: ${step.error}`, "error");
	} else {
		appendOutput("No output yet", "system");
	}

	// Re-render pipeline steps to update selected state
	renderPipelineSteps(wf, selectedStepIndex, selectStep);
}

function autoSelectStep(wf: WorkflowState): void {
	if (wf.status === "running" || wf.status === "waiting_for_input" || wf.status === "paused") {
		selectStep(wf.currentStepIndex);
	} else if (wf.steps.length > 0) {
		// Select last non-pending step, or first step if all pending
		let lastActive = 0;
		for (let i = wf.steps.length - 1; i >= 0; i--) {
			if (wf.steps[i].status !== "pending") {
				lastActive = i;
				break;
			}
		}
		selectStep(lastActive);
	}
}

function renderWorkflowDetail(entry: WorkflowClientState, epicContext?: EpicAggregatedState): void {
	const wf = entry.state;

	// Render status, pipeline, summary
	updateWorkflowStatus(wf);
	updateBranchInfo(wf);
	renderPipelineSteps(wf, selectedStepIndex, selectStep);
	if (wf.summary) updateSummary(wf.summary);
	updateStepSummary(wf.stepSummary ?? "");
	updateFlavor(wf.flavor ?? "");
	updateUserInput(wf.specification);
	updateSpecDetails("");

	// Action buttons: Pause, Resume, Abort, Retry, and epic-specific actions
	const actions: { label: string; className: string; onClick: () => void }[] = [];
	const isError = wf.status === "error";

	if (wf.status === "running") {
		actions.push({
			label: "Pause",
			className: "btn-secondary",
			onClick: () => send({ type: "workflow:pause", workflowId: wf.id }),
		});
	}
	if (wf.status === "paused") {
		actions.push({
			label: "Resume",
			className: "btn-primary",
			onClick: () => send({ type: "workflow:resume", workflowId: wf.id }),
		});
		actions.push({
			label: "Abort",
			className: "btn-danger",
			onClick: () => {
				if (confirm("Are you sure you want to abort this workflow?")) {
					send({ type: "workflow:abort", workflowId: wf.id });
				}
			},
		});
	}
	if (wf.status === "waiting_for_input" || wf.status === "waiting_for_dependencies") {
		actions.push({
			label: "Abort",
			className: "btn-danger",
			onClick: () => {
				if (confirm("Are you sure you want to abort this workflow?")) {
					send({ type: "workflow:abort", workflowId: wf.id });
				}
			},
		});
	}
	if (isError) {
		actions.push({
			label: "Retry",
			className: "btn-secondary",
			onClick: () => send({ type: "workflow:retry", workflowId: wf.id }),
		});
	}
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

	// Add breadcrumb above user-input if viewing within an epic context
	if (epicContext) {
		const userInput = document.getElementById("user-input");
		if (userInput) {
			const breadcrumb = document.createElement("div");
			breadcrumb.className = "epic-breadcrumb";
			breadcrumb.id = "epic-breadcrumb";
			breadcrumb.textContent = `\u2190 Epic: ${epicContext.title}`;
			breadcrumb.addEventListener("click", returnToEpicTree);
			userInput.parentElement?.insertBefore(breadcrumb, userInput);
		}
	}

	// Auto-select a step and render its output
	autoSelectStep(wf);

	// Question
	const isTerminal =
		wf.status === "cancelled" || wf.status === "completed" || wf.status === "error";
	if (wf.pendingQuestion && !isTerminal) {
		showQuestion(wf.pendingQuestion);
	} else {
		hideQuestion();
	}
}

function getLastTargetRepo(): string {
	// Find the most recently created workflow with a targetRepository
	let latest: { repo: string; date: string } | null = null;
	for (const [, entry] of workflows) {
		const repo = entry.state.targetRepository;
		if (repo) {
			if (!latest || entry.state.createdAt > latest.date) {
				latest = { repo, date: entry.state.createdAt };
			}
		}
	}
	return latest?.repo ?? "";
}

function openSpecModal(): void {
	const content = document.createElement("div");

	const repoField = document.createElement("div");
	repoField.className = "modal-field";
	const repoLabel = document.createElement("label");
	repoLabel.textContent = "Target Repository";
	repoField.appendChild(repoLabel);
	const repoPicker = createFolderPicker("~/git");
	repoPicker.setValue(getLastTargetRepo());
	repoField.appendChild(repoPicker.element);

	const specField = document.createElement("div");
	specField.className = "modal-field";
	const specLabel = document.createElement("label");
	specLabel.textContent = "Specification";
	specField.appendChild(specLabel);
	const specInput = document.createElement("textarea");
	specInput.placeholder = "Describe the feature you want to build...";
	specInput.rows = 5;
	specField.appendChild(specInput);

	const errorEl = document.createElement("div");
	errorEl.className = "modal-error hidden";

	const actions = document.createElement("div");
	actions.className = "modal-actions";
	const btnStart = document.createElement("button");
	btnStart.className = "btn btn-primary";
	btnStart.textContent = "Start";
	actions.appendChild(btnStart);

	content.appendChild(repoField);
	content.appendChild(specField);
	content.appendChild(errorEl);
	content.appendChild(actions);

	const modal = createModal("New Specification", content);

	function submit() {
		const spec = specInput.value.trim();
		if (!spec) {
			errorEl.textContent = "Specification is required";
			errorEl.classList.remove("hidden");
			return;
		}
		errorEl.classList.add("hidden");
		const targetRepo = repoPicker.getValue();
		send({
			type: "workflow:start",
			specification: spec,
			...(targetRepo ? { targetRepository: targetRepo } : {}),
		});
		modal.hide();
	}

	btnStart.addEventListener("click", submit);
	specInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			submit();
		}
	});

	modal.show();
}

function openEpicModal(): void {
	const content = document.createElement("div");

	const repoField = document.createElement("div");
	repoField.className = "modal-field";
	const repoLabel = document.createElement("label");
	repoLabel.textContent = "Target Repository";
	repoField.appendChild(repoLabel);
	const repoPicker = createFolderPicker("~/git");
	repoPicker.setValue(getLastTargetRepo());
	repoField.appendChild(repoPicker.element);

	const descField = document.createElement("div");
	descField.className = "modal-field";
	const descLabel = document.createElement("label");
	descLabel.textContent = "Epic Description";
	descField.appendChild(descLabel);
	const descInput = document.createElement("textarea");
	descInput.placeholder = "Describe a large feature to decompose into multiple specs...";
	descInput.rows = 5;
	descField.appendChild(descInput);

	const errorEl = document.createElement("div");
	errorEl.className = "modal-error hidden";

	const actions = document.createElement("div");
	actions.className = "modal-actions";
	const btnCreateStart = document.createElement("button");
	btnCreateStart.className = "btn btn-primary";
	btnCreateStart.textContent = "Create + Start";
	const btnCreate = document.createElement("button");
	btnCreate.className = "btn btn-secondary";
	btnCreate.textContent = "Create";
	actions.appendChild(btnCreateStart);
	actions.appendChild(btnCreate);

	content.appendChild(repoField);
	content.appendChild(descField);
	content.appendChild(errorEl);
	content.appendChild(actions);

	const modal = createModal("New Epic", content);

	function submitEpic(autoStart: boolean) {
		const desc = descInput.value.trim();
		if (desc.length < 10) {
			errorEl.textContent = "Description must be at least 10 characters";
			errorEl.classList.remove("hidden");
			return;
		}
		errorEl.classList.add("hidden");
		const targetRepo = repoPicker.getValue();
		send({
			type: "epic:start",
			description: desc,
			autoStart,
			...(targetRepo ? { targetRepository: targetRepo } : {}),
		});
		modal.hide();
	}

	btnCreateStart.addEventListener("click", () => submitEpic(true));
	btnCreate.addEventListener("click", () => submitEpic(false));

	modal.show();
}

// Wire up UI events
document.addEventListener("DOMContentLoaded", () => {
	const btnSubmitAnswer = $("#btn-submit-answer") as HTMLButtonElement;
	const btnSkip = $("#btn-skip-question") as HTMLButtonElement;

	// Header buttons → modals
	const btnNewSpec = document.getElementById("btn-new-spec");
	if (btnNewSpec) btnNewSpec.addEventListener("click", openSpecModal);

	const btnNewEpic = document.getElementById("btn-new-epic");
	if (btnNewEpic) btnNewEpic.addEventListener("click", openEpicModal);

	// Question panel
	btnSubmitAnswer.addEventListener("click", () => {
		const answer = getAnswer();
		const workflowId = selectedChildId ?? expandedId;
		if (!answer || !workflowId) return;

		const entry = workflows.get(workflowId);
		if (!entry?.state.pendingQuestion) return;

		send({
			type: "workflow:answer",
			workflowId,
			questionId: entry.state.pendingQuestion.id,
			answer,
		});
	});

	btnSkip.addEventListener("click", () => {
		const workflowId = selectedChildId ?? expandedId;
		if (!workflowId) return;

		const entry = workflows.get(workflowId);
		if (!entry?.state.pendingQuestion) return;

		send({
			type: "workflow:skip",
			workflowId,
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

	// Config panel
	const configPanel = createConfigPanel(send);
	const configContainer = document.getElementById("config-panel");
	if (configContainer) configContainer.appendChild(configPanel);

	// Config overlay (click-outside-to-close)
	const overlay = document.createElement("div");
	overlay.id = "config-overlay";
	overlay.className = "config-overlay hidden";
	overlay.addEventListener("click", () => hideConfigPanel());
	document.body.appendChild(overlay);

	const btnConfig = document.getElementById("btn-config");
	if (btnConfig) {
		btnConfig.addEventListener("click", () => {
			const panel = document.getElementById("config-panel");
			if (panel?.classList.contains("hidden")) {
				showConfigPanel(send);
			} else {
				hideConfigPanel();
			}
		});
	}

	// Timer update interval
	setInterval(updateTimers, 1000);

	connect();
});
