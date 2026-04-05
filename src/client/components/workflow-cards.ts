import type {
	ClientMessage,
	EpicClientState,
	WorkflowClientState,
	WorkflowState,
} from "../../types";

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

const STATUS_LABELS: Record<string, string> = {
	idle: "Idle",
	running: "Running",
	waiting_for_input: "Waiting",
	waiting_for_dependencies: "Waiting",
	completed: "Done",
	cancelled: "Cancelled",
	error: "Error",
};

const STATUS_CLASSES: Record<string, string> = {
	idle: "card-status-idle",
	running: "card-status-running",
	waiting_for_input: "card-status-waiting",
	waiting_for_dependencies: "card-status-waiting-deps",
	completed: "card-status-completed",
	cancelled: "card-status-cancelled",
	error: "card-status-error",
};

// Store references for force-start
let sendFn: ((msg: ClientMessage) => void) | null = null;
let allWorkflowsRef: Map<string, WorkflowClientState> | null = null;

export function renderCardStrip(
	workflowOrder: string[],
	workflows: Map<string, WorkflowClientState>,
	epics: Map<string, EpicClientState>,
	expandedId: string | null,
	onCardClick: (id: string) => void,
	send?: (msg: ClientMessage) => void,
): void {
	const container = $("#card-strip");
	if (!container) return;

	if (send) sendFn = send;
	allWorkflowsRef = workflows;
	container.replaceChildren();

	// Render epic cards first
	for (const epic of epics.values()) {
		const card = createEpicCard(epic, expandedId, onCardClick);
		container.appendChild(card);
	}

	for (const id of workflowOrder) {
		const entry = workflows.get(id);
		if (!entry) continue;

		const card = createCompactCard(entry.state, expandedId, onCardClick);
		container.appendChild(card);
	}
}

function createCompactCard(
	wf: WorkflowState,
	expandedWorkflowId: string | null,
	onClick: (workflowId: string) => void,
): HTMLElement {
	const card = document.createElement("div");
	card.className = "workflow-card";
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

	// Epic label (US2)
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

	// Dependency text (US3)
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

	// Start button for idle epic workflows (non-autoStart)
	if (wf.status === "idle" && wf.epicId && sendFn) {
		const startBtn = document.createElement("button");
		startBtn.className = "btn-card-action";
		startBtn.textContent = "Start";
		startBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			sendFn?.({ type: "workflow:start-existing", workflowId: wf.id });
		});
		card.appendChild(startBtn);
	}

	// Force Start button (US4)
	if (wf.status === "waiting_for_dependencies" && sendFn) {
		const forceBtn = document.createElement("button");
		forceBtn.className = "btn-force-start";
		forceBtn.textContent = "Force Start";
		forceBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			sendFn?.({ type: "workflow:force-start", workflowId: wf.id });
		});
		card.appendChild(forceBtn);
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
	const timer = document.createElement("span");
	timer.className = "card-timer";
	timer.dataset.activeWorkMs = String(wf.activeWorkMs);
	timer.dataset.activeWorkStartedAt = wf.activeWorkStartedAt || "";
	timer.textContent = formatTimer(wf.activeWorkMs, wf.activeWorkStartedAt);
	card.appendChild(timer);

	card.addEventListener("click", () => onClick(wf.id));

	return card;
}

const EPIC_STATUS_LABELS: Record<string, string> = {
	analyzing: "Analyzing",
	completed: "Done",
	error: "Error",
};

const EPIC_STATUS_CLASSES: Record<string, string> = {
	analyzing: "card-status-running",
	completed: "card-status-completed",
	error: "card-status-error",
};

function createEpicCard(
	epic: EpicClientState,
	expandedId: string | null,
	onClick: (id: string) => void,
): HTMLElement {
	const card = document.createElement("div");
	card.className = "workflow-card epic-card";
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

	// Description
	const summary = document.createElement("span");
	summary.className = "card-summary";
	summary.textContent =
		epic.description.length > 120 ? `${epic.description.slice(0, 120)}...` : epic.description;
	card.appendChild(summary);

	// Timer
	const timer = document.createElement("span");
	timer.className = "card-timer";
	timer.dataset.activeWorkMs = "0";
	timer.dataset.activeWorkStartedAt = epic.status === "analyzing" ? epic.startedAt : "";
	timer.textContent = formatTimer(0, epic.status === "analyzing" ? epic.startedAt : null);
	card.appendChild(timer);

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
