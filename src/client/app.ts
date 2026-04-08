import type {
	ClientMessage,
	EpicAggregatedState,
	EpicClientState,
	ServerMessage,
	WorkflowClientState,
	WorkflowState,
} from "../types";
import { ClientStateManager } from "./client-state-manager";
import {
	createConfigPanel,
	hideConfigPanel,
	hidePurgeProgress,
	showConfigPanel,
	showPurgeProgress,
	updateConfigPanel,
	updatePurgeProgress,
} from "./components/config-panel";
import { createModal } from "./components/creation-modal";
import { renderEpicTree } from "./components/epic-tree";
import { updateFavicon } from "./components/favicon";
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
import { renderMarkdown } from "./render-markdown";

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

const stateManager = new ClientStateManager();

let ws: WebSocket | null = null;
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

function handleMessage(msg: ServerMessage): void {
	// Capture pre-mutation state needed for view-side decisions
	const expandedId = stateManager.getExpandedId();
	const expandedEpicId = stateManager.getExpandedEpicId();
	const selectedStepIndex = stateManager.getSelectedStepIndex();
	const selectedChildId = stateManager.getSelectedChildId();
	const workflows = stateManager.getWorkflows();
	const epics = stateManager.getEpics();

	// Pre-mutation snapshots for step-change
	let wasWatchingRunning = false;
	if (msg.type === "workflow:step-change") {
		const entry = workflows.get(msg.workflowId);
		if (entry) {
			wasWatchingRunning = selectedStepIndex === entry.state.currentStepIndex;
		}
	}

	// Mutate state and get change descriptor
	const change = stateManager.handleMessage(msg);

	// View-layer rendering based on message type and change
	switch (msg.type) {
		case "workflow:list": {
			renderCards();
			const standaloneWorkflows = msg.workflows.filter((w) => !w.epicId);
			if (standaloneWorkflows.length === 1 && stateManager.getEpicAggregates().size === 0) {
				expandItem(standaloneWorkflows[0].id);
			} else if (stateManager.getEpicAggregates().size === 1 && standaloneWorkflows.length === 0) {
				const epicId = [...stateManager.getEpicAggregates().keys()][0];
				expandItem(`${EPIC_CARD_PREFIX}${epicId}`);
			} else {
				renderExpandedView();
			}
			break;
		}

		case "workflow:created": {
			renderCards();
			if (!epics.has(expandedId ?? "") && !msg.workflow.epicId) {
				expandItem(msg.workflow.id);
			}
			if (expandedEpicId && msg.workflow.epicId === expandedEpicId) {
				renderExpandedView();
			}
			break;
		}

		case "workflow:state": {
			if (!msg.workflow) break;
			renderCards();
			if (expandedId === msg.workflow.id) {
				renderExpandedView();
			}
			if (expandedEpicId && msg.workflow.epicId === expandedEpicId) {
				renderExpandedView();
			}
			break;
		}

		case "workflow:output": {
			if (change.scope.entity === "none") break;
			const entry = workflows.get(msg.workflowId);
			if (
				entry &&
				(expandedId === msg.workflowId || selectedChildId === msg.workflowId) &&
				selectedStepIndex === entry.state.currentStepIndex
			) {
				appendOutput(msg.text);
			}
			break;
		}

		case "workflow:tools": {
			if (change.scope.entity === "none") break;
			const entry = workflows.get(msg.workflowId);
			if (
				entry &&
				(expandedId === msg.workflowId || selectedChildId === msg.workflowId) &&
				selectedStepIndex === entry.state.currentStepIndex
			) {
				appendToolIcons(msg.tools);
			}
			break;
		}

		case "workflow:question": {
			if (change.scope.entity === "none") break;
			renderCards();
			if (expandedId === msg.workflowId || selectedChildId === msg.workflowId) {
				showQuestion(msg.question);
			}
			break;
		}

		case "workflow:step-change": {
			if (change.scope.entity === "none") break;
			renderCards();
			if (expandedId === msg.workflowId || selectedChildId === msg.workflowId) {
				if (wasWatchingRunning) {
					selectStep(msg.currentStepIndex);
				} else {
					const entry = workflows.get(msg.workflowId);
					if (entry) {
						renderPipelineSteps(entry.state, stateManager.getSelectedStepIndex(), selectStep);
					}
				}
			}
			break;
		}

		case "epic:list": {
			renderCards();
			renderExpandedView();
			break;
		}

		case "epic:created": {
			renderCards();
			expandItem(msg.epicId);
			break;
		}

		case "epic:summary": {
			if (change.scope.entity === "none") break;
			renderCards();
			if (expandedId === msg.epicId) {
				updateSummary(msg.summary);
			}
			break;
		}

		case "epic:output": {
			if (change.scope.entity === "none") break;
			if (expandedId === msg.epicId) {
				appendOutput(msg.text);
			}
			break;
		}

		case "epic:tools": {
			if (change.scope.entity === "none") break;
			if (expandedId === msg.epicId) {
				appendToolIcons(msg.tools);
			}
			break;
		}

		case "epic:result": {
			if (change.scope.entity === "none") break;
			renderCards();
			if (expandedId === msg.epicId) {
				expandItem(`${EPIC_CARD_PREFIX}${msg.epicId}`);
			}
			break;
		}

		case "epic:infeasible": {
			if (change.scope.entity === "none") break;
			renderCards();
			if (expandedId === msg.epicId) {
				renderExpandedView();
			}
			break;
		}

		case "epic:error": {
			if (change.scope.entity === "none") break;
			renderCards();
			if (expandedId === msg.epicId) {
				appendOutput(`Error: ${msg.message}`, "error");
			}
			break;
		}

		case "epic:dependency-update": {
			if (change.scope.entity === "none") break;
			renderCards();
			if (expandedId === msg.workflowId) {
				renderExpandedView();
			}
			const entry = workflows.get(msg.workflowId);
			if (expandedEpicId && entry?.state.epicId === expandedEpicId) {
				renderExpandedView();
			}
			break;
		}

		case "purge:progress": {
			showPurgeProgress();
			updatePurgeProgress(msg.step, msg.current, msg.total);
			break;
		}

		case "purge:complete": {
			hidePurgeProgress();
			hideConfigPanel();
			renderCards();
			renderExpandedView();
			if (msg.warnings.length > 0) {
				appendOutput(`Purge completed with warnings: ${msg.warnings.join("; ")}`, "error");
			}
			break;
		}

		case "config:state": {
			updateConfigPanel(msg.config, msg.warnings);
			syncAutoModeToggle(msg.config.autoMode);
			break;
		}

		case "config:error": {
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
	stateManager.expandItem(id);
	renderCards();
	renderExpandedView();
}

function selectChild(workflowId: string): void {
	stateManager.selectChild(workflowId);
	renderExpandedView();
}

function returnToEpicTree(): void {
	// selectChild toggles off when called with the currently selected child
	const currentChild = stateManager.getSelectedChildId();
	if (currentChild) {
		stateManager.selectChild(currentChild);
	}
	renderExpandedView();
}

function syncAutoModeToggle(active: boolean): void {
	const btn = document.getElementById("btn-auto-mode");
	if (!btn) return;
	btn.classList.toggle("active", active);
	const icon = btn.querySelector(".toggle-icon");
	if (icon) icon.textContent = active ? "✓" : "✕";
}

function renderCards(): void {
	const workflows = stateManager.getWorkflows();
	const epics = stateManager.getEpics();
	const epicAggregates = stateManager.getEpicAggregates();
	const cardOrder = stateManager.getCardOrder();
	const expandedId = stateManager.getExpandedId();

	renderCardStrip(cardOrder, workflows, epics, epicAggregates, expandedId, expandItem);

	let needsAttention = false;
	for (const [, entry] of workflows) {
		const s = entry.state.status;
		if (s === "waiting_for_input" || s === "error") {
			needsAttention = true;
			break;
		}
	}
	updateFavicon(needsAttention);
}

function renderExpandedView(): void {
	const expandedId = stateManager.getExpandedId();
	const expandedEpicId = stateManager.getExpandedEpicId();
	const selectedChildId = stateManager.getSelectedChildId();
	const workflows = stateManager.getWorkflows();
	const epics = stateManager.getEpics();
	const epicAggregates = stateManager.getEpicAggregates();

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
			notesEl.innerHTML = renderMarkdown(epic.infeasibleNotes);
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
	const workflows = stateManager.getWorkflows();
	const epics = stateManager.getEpics();

	// Update status area for epic
	const statusBadge = $("#workflow-status");
	statusBadge.textContent = agg.status;
	statusBadge.className = `status-badge ${EPIC_AGG_STATUS_CLASSES[agg.status] || "card-status-idle"}`;

	updateBranchInfo(null);
	renderPipelineSteps(null);
	updateSummary(`${agg.title} (${agg.progress.completed}/${agg.progress.total} completed)`);
	updateStepSummary("");
	const stepLabel = document.getElementById("current-step-label");
	if (stepLabel) stepLabel.classList.add("hidden");
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
	const outputAreaEl = $("#output-area");
	outputAreaEl.classList.add("epic-tree-fullsize");

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
	container.innerHTML = renderMarkdown(content);

	// Insert after user-input
	const userInput = document.getElementById("user-input");
	if (userInput) {
		userInput.parentElement?.insertBefore(container, userInput.nextSibling);
	}
}

function renderChildDetailView(childId: string, epicAgg: EpicAggregatedState): void {
	const entry = stateManager.getWorkflows().get(childId);
	if (!entry) return;

	renderWorkflowDetail(entry, epicAgg);
}

function selectStep(index: number): void {
	stateManager.selectStep(index);

	const selectedChildId = stateManager.getSelectedChildId();
	const expandedId = stateManager.getExpandedId();
	const workflowId = selectedChildId ?? expandedId;
	const entry = workflowId ? stateManager.getWorkflows().get(workflowId) : null;
	if (!entry) return;

	const wf = entry.state;
	const step = wf.steps[index];
	if (!step) return;

	clearOutput();

	if (
		index === wf.currentStepIndex &&
		(wf.status === "running" || wf.status === "waiting_for_input")
	) {
		// Show live accumulated output, fall back to persisted step.output after restart
		if (entry.outputLines.length > 0) {
			renderOutputEntries(entry.outputLines);
		} else if (step.output) {
			appendOutput(step.output);
		}
	} else if (step.output || step.error) {
		// Show stored step output
		if (step.output) appendOutput(step.output);
		if (step.error) appendOutput(`Error: ${step.error}`, "error");
	} else {
		appendOutput("No output yet", "system");
	}

	// Re-render pipeline steps to update selected state
	renderPipelineSteps(wf, stateManager.getSelectedStepIndex(), selectStep);
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
	const selectedStepIndex = stateManager.getSelectedStepIndex();

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

function openSpecModal(): void {
	const content = document.createElement("div");

	const repoField = document.createElement("div");
	repoField.className = "modal-field";
	const repoLabel = document.createElement("label");
	repoLabel.textContent = "Target Repository";
	repoField.appendChild(repoLabel);
	const repoPicker = createFolderPicker("~/git");
	repoPicker.setValue(stateManager.getLastTargetRepo());
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
	repoPicker.setValue(stateManager.getLastTargetRepo());
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

	// Auto-mode toggle
	const btnAutoMode = document.getElementById("btn-auto-mode");
	if (btnAutoMode) {
		btnAutoMode.addEventListener("click", () => {
			const isActive = btnAutoMode.classList.contains("active");
			send({ type: "config:save", config: { autoMode: !isActive } });
		});
	}

	// Question panel
	btnSubmitAnswer.addEventListener("click", () => {
		const answer = getAnswer();
		const workflowId = stateManager.getSelectedChildId() ?? stateManager.getExpandedId();
		if (!answer || !workflowId) return;

		const entry = stateManager.getWorkflows().get(workflowId);
		if (!entry?.state.pendingQuestion) return;

		send({
			type: "workflow:answer",
			workflowId,
			questionId: entry.state.pendingQuestion.id,
			answer,
		});
	});

	btnSkip.addEventListener("click", () => {
		const workflowId = stateManager.getSelectedChildId() ?? stateManager.getExpandedId();
		if (!workflowId) return;

		const entry = stateManager.getWorkflows().get(workflowId);
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
