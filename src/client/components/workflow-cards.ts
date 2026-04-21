import type {
	EpicAggregatedState,
	EpicClientState,
	WorkflowClientState,
	WorkflowKind,
	WorkflowState,
} from "../../types";
import { $, createTimerElement } from "../dom";
import {
	EPIC_AGG_STATUS_CLASSES,
	EPIC_CARD_PREFIX,
	STATUS_CLASSES,
	STATUS_LABELS,
} from "./status-maps";

// Store reference for dependency name resolution
let allWorkflowsRef: ReadonlyMap<string, WorkflowClientState> | null = null;

type CardKind = "epic" | "spec" | "quick-fix";

const CARD_KIND_LABELS: Record<CardKind, string> = {
	epic: "Epic",
	spec: "Spec",
	"quick-fix": "Quick Fix",
};

function kindFromWorkflow(workflowKind: WorkflowKind): CardKind {
	switch (workflowKind) {
		case "quick-fix":
			return "quick-fix";
		case "spec":
			return "spec";
	}
}

function prependTypeBadge(card: HTMLElement, kind: CardKind): void {
	const badge = document.createElement("span");
	badge.className = `card-type-badge card-type-badge--${kind}`;
	badge.textContent = CARD_KIND_LABELS[kind];
	card.prepend(badge);
}

export function renderCardStrip(
	cardOrder: readonly string[],
	workflows: ReadonlyMap<string, WorkflowClientState>,
	epics: ReadonlyMap<string, EpicClientState>,
	epicAggregates: ReadonlyMap<string, EpicAggregatedState>,
	expandedId: string | null,
	onCardClick: (id: string) => void,
): void {
	const container = $("#card-strip");
	if (!container) return;

	allWorkflowsRef = workflows;
	container.replaceChildren();

	for (const id of cardOrder) {
		// Aggregated epic card (epic:{epicId})
		if (id.startsWith(EPIC_CARD_PREFIX)) {
			const epicId = id.slice(EPIC_CARD_PREFIX.length);
			const agg = epicAggregates.get(epicId);
			if (agg) {
				container.appendChild(createAggregatedEpicCard(agg, expandedId, onCardClick));
				continue;
			}
		}

		// Epic analysis card (transient)
		const epic = epics.get(id);
		if (epic) {
			container.appendChild(createEpicAnalysisCard(epic, expandedId, onCardClick));
			continue;
		}

		// Regular workflow card
		const entry = workflows.get(id);
		if (entry) {
			container.appendChild(createCompactCard(entry.state, expandedId, onCardClick));
		}
	}
}

function createCompactCard(
	wf: WorkflowState,
	expandedWorkflowId: string | null,
	onClick: (workflowId: string) => void,
): HTMLElement {
	const card = document.createElement("div");
	const kind: CardKind = kindFromWorkflow(wf.workflowKind);
	card.className = `workflow-card workflow-card--${kind}`;
	card.dataset.workflowId = wf.id;

	if (expandedWorkflowId === wf.id) {
		card.classList.add("card-expanded");
	}

	// Pulse when waiting_for_input and not expanded
	if (wf.status === "waiting_for_input" && expandedWorkflowId !== wf.id) {
		card.classList.add("card-pulse");
	}

	// Error state when not expanded
	if (wf.status === "error" && expandedWorkflowId !== wf.id) {
		card.classList.add("card-error-glow");
	}

	// Status badge
	const badge = document.createElement("span");
	badge.className = `card-status ${STATUS_CLASSES[wf.status] || "card-status-idle"}`;
	badge.textContent = STATUS_LABELS[wf.status] || wf.status;
	card.appendChild(badge);

	// Epic label
	if (wf.epicId && wf.epicTitle) {
		const epicLabel = document.createElement("span");
		epicLabel.className = "card-epic-label";
		epicLabel.textContent = `Epic: ${wf.epicTitle}`;
		card.appendChild(epicLabel);
	}

	// Summary (full text, no truncation)
	const summary = document.createElement("span");
	summary.className = "card-summary";
	summary.textContent = wf.summary || wf.specification;
	card.appendChild(summary);

	// Dependency text
	if (wf.epicDependencies && wf.epicDependencies.length > 0 && allWorkflowsRef) {
		const depNames = wf.epicDependencies
			.map((depId) => {
				const depEntry = allWorkflowsRef?.get(depId);
				return depEntry?.state.summary || depId.slice(0, 8);
			})
			.join(", ");
		const depText = document.createElement("span");
		depText.className = "card-dependency-text";
		depText.textContent = `Depends on: ${depNames}`;
		card.appendChild(depText);
	}

	// Current step
	if (wf.steps.length > 0) {
		const currentStep = wf.steps[wf.currentStepIndex];
		if (currentStep && (wf.status === "running" || wf.status === "waiting_for_input")) {
			const step = document.createElement("span");
			step.className = "card-step";
			step.textContent = currentStep.displayName;
			card.appendChild(step);
		}
	}

	// Timer
	card.appendChild(createTimerElement(wf.activeWorkMs, wf.activeWorkStartedAt, formatTimer));

	prependTypeBadge(card, kind);

	card.addEventListener("click", () => onClick(wf.id));

	return card;
}

const EPIC_STATUS_LABELS: Record<string, string> = {
	analyzing: "Analyzing",
	completed: "Done",
	error: "Error",
	infeasible: "Infeasible",
};

const EPIC_STATUS_CLASSES: Record<string, string> = {
	analyzing: "card-status-running",
	completed: "card-status-completed",
	error: "card-status-error",
	infeasible: "card-status-error",
};

const EPIC_AGG_STATUS_LABELS: Record<string, string> = {
	idle: "Idle",
	running: "Running",
	waiting: "Waiting",
	error: "Error",
	in_progress: "In Progress",
	completed: "Done",
};

function createAggregatedEpicCard(
	agg: EpicAggregatedState,
	expandedId: string | null,
	onClick: (id: string) => void,
): HTMLElement {
	const card = document.createElement("div");
	card.className = "workflow-card workflow-card--epic";
	card.dataset.epicId = agg.epicId;

	const cardId = `${EPIC_CARD_PREFIX}${agg.epicId}`;
	if (expandedId === cardId) {
		card.classList.add("card-expanded");
	}

	if (agg.status === "error" && expandedId !== cardId) {
		card.classList.add("card-error-glow");
	}

	// Pulse when waiting and not expanded
	if (agg.status === "waiting" && expandedId !== cardId) {
		card.classList.add("card-pulse");
	}

	// Epic icon + status badge
	const badge = document.createElement("span");
	badge.className = `card-status ${EPIC_AGG_STATUS_CLASSES[agg.status] || "card-status-idle"}`;
	badge.textContent = EPIC_AGG_STATUS_LABELS[agg.status] || agg.status;
	card.appendChild(badge);

	// Epic label
	const label = document.createElement("span");
	label.className = "card-epic-label";
	label.textContent = `Epic: ${agg.title}`;
	card.appendChild(label);

	// Progress text
	const progress = document.createElement("span");
	progress.className = "card-summary";
	progress.textContent = `${agg.progress.completed}/${agg.progress.total} completed`;
	card.appendChild(progress);

	// Timer — sum of active work time across children
	card.appendChild(createTimerElement(agg.activeWorkMs, agg.activeWorkStartedAt, formatTimer));

	prependTypeBadge(card, "epic");

	card.addEventListener("click", () => onClick(cardId));

	return card;
}

function createEpicAnalysisCard(
	epic: EpicClientState,
	expandedId: string | null,
	onClick: (id: string) => void,
): HTMLElement {
	const card = document.createElement("div");
	card.className = "workflow-card workflow-card--epic";
	card.dataset.epicId = epic.epicId;

	if (expandedId === epic.epicId) {
		card.classList.add("card-expanded");
	}

	if (epic.status === "error" && expandedId !== epic.epicId) {
		card.classList.add("card-error-glow");
	}

	// Status badge
	const badge = document.createElement("span");
	badge.className = `card-status ${EPIC_STATUS_CLASSES[epic.status] || "card-status-idle"}`;
	badge.textContent = EPIC_STATUS_LABELS[epic.status] || epic.status;
	card.appendChild(badge);

	// Epic label
	const label = document.createElement("span");
	label.className = "card-epic-label";
	label.textContent = epic.title ? `Epic: ${epic.title}` : "Epic";
	card.appendChild(label);

	// Summary or description
	const summary = document.createElement("span");
	summary.className = "card-summary";
	summary.textContent = epic.title || epic.description;
	card.appendChild(summary);

	// Timer — compute elapsed ms for completed/error epics, live for analyzing
	const timer = document.createElement("span");
	timer.className = "card-timer";
	const isAnalyzing = epic.status === "analyzing";
	const elapsedMs = epic.completedAt
		? new Date(epic.completedAt).getTime() - new Date(epic.startedAt).getTime()
		: 0;
	timer.dataset.activeWorkMs = String(elapsedMs);
	timer.dataset.activeWorkStartedAt = isAnalyzing ? epic.startedAt : "";
	timer.textContent = formatTimer(elapsedMs, isAnalyzing ? epic.startedAt : null);
	card.appendChild(timer);

	prependTypeBadge(card, "epic");

	card.addEventListener("click", () => onClick(epic.epicId));

	return card;
}

export function formatTimer(activeWorkMs: number, activeWorkStartedAt: string | null): string {
	let totalMs = activeWorkMs;
	if (activeWorkStartedAt) {
		totalMs += Date.now() - new Date(activeWorkStartedAt).getTime();
	}

	if (totalMs <= 0) return "0:00";

	const totalSeconds = Math.floor(totalMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		const mins = minutes % 60;
		return `${hours}:${String(mins).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	}

	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Called every second to update all timer displays
export function updateTimers(): void {
	const timers = document.querySelectorAll<HTMLElement>(".card-timer");
	for (const timer of timers) {
		const ms = parseInt(timer.dataset.activeWorkMs || "0", 10);
		const startedAt = timer.dataset.activeWorkStartedAt || null;
		timer.textContent = formatTimer(ms, startedAt || null);
	}
}
