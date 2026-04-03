import type { WorkflowClientState, WorkflowState } from "../../types";

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

const STATUS_LABELS: Record<string, string> = {
	idle: "Idle",
	running: "Running",
	waiting_for_input: "Waiting",
	completed: "Done",
	cancelled: "Cancelled",
	error: "Error",
};

const STATUS_CLASSES: Record<string, string> = {
	idle: "card-status-idle",
	running: "card-status-running",
	waiting_for_input: "card-status-waiting",
	completed: "card-status-completed",
	cancelled: "card-status-cancelled",
	error: "card-status-error",
};

export function renderCardStrip(
	workflowOrder: string[],
	workflows: Map<string, WorkflowClientState>,
	expandedWorkflowId: string | null,
	onCardClick: (workflowId: string) => void,
): void {
	const container = $("#card-strip");
	if (!container) return;

	container.replaceChildren();

	for (const id of workflowOrder) {
		const entry = workflows.get(id);
		if (!entry) continue;

		const card = createCompactCard(entry.state, expandedWorkflowId, onCardClick);
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

	// Summary (full text, no truncation)
	const summary = document.createElement("span");
	summary.className = "card-summary";
	summary.textContent = wf.summary || wf.specification;
	card.appendChild(summary);

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
