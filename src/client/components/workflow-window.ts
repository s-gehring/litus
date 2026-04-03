import type { WorkflowState } from "../../types";

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

export function updateWorkflowStatus(workflow: WorkflowState | null): void {
	const statusBadge = $("#workflow-status");
	const btnStart = $("#btn-start") as HTMLButtonElement;
	const btnCancel = $("#btn-cancel") as HTMLButtonElement;
	const btnRetry = $("#btn-retry") as HTMLButtonElement | null;
	const status = workflow?.status || "idle";

	statusBadge.textContent = status.replace("_", " ");
	statusBadge.className = `status-badge ${status}`;

	const isActive = status === "running" || status === "waiting_for_input";
	const isError = status === "error";

	// Start button always visible — multi-workflow: users can always start new workflows
	btnStart.classList.remove("hidden");
	btnCancel.classList.toggle("hidden", !isActive);
	if (btnRetry) {
		btnRetry.classList.toggle("hidden", !isError);
	}
	// Never disable inputs — multi-workflow: input area is always accessible (FR-009, US5)
	btnStart.disabled = false;

	// Show current step name in status area
	const stepLabel = $("#current-step-label");
	if (stepLabel && workflow && workflow.steps.length > 0) {
		const currentStep = workflow.steps[workflow.currentStepIndex];
		if (currentStep && isActive) {
			stepLabel.textContent = currentStep.displayName;
			stepLabel.classList.remove("hidden");
		} else {
			stepLabel.classList.add("hidden");
		}
	}

	// Render collapsed completed steps
	renderStepHistory(workflow);
}

function renderStepHistory(workflow: WorkflowState | null): void {
	const historyContainer = $("#step-history");
	if (!historyContainer) return;

	if (!workflow || workflow.steps.length === 0) {
		historyContainer.replaceChildren();
		return;
	}

	historyContainer.replaceChildren();

	for (let i = 0; i < workflow.currentStepIndex; i++) {
		const step = workflow.steps[i];
		if (step.status !== "completed") continue;

		const item = document.createElement("details");
		item.className = "step-history-item";

		const summary = document.createElement("summary");
		summary.className = "step-history-summary";
		summary.textContent = `${step.displayName} — completed`;
		item.appendChild(summary);

		if (step.output) {
			const output = document.createElement("div");
			output.className = "step-history-output";
			// Show last 500 chars to keep it manageable
			const trimmed = step.output.length > 500 ? `...${step.output.slice(-500)}` : step.output;
			output.textContent = trimmed;
			item.appendChild(output);
		}

		historyContainer.appendChild(item);
	}
}

export function appendOutput(text: string, type: "normal" | "error" | "system" = "normal"): void {
	const log = $("#output-log");
	const line = document.createElement("div");
	line.className = `output-line ${type}`;
	line.textContent = text;
	log.appendChild(line);
	log.scrollTop = log.scrollHeight;
}

export function clearOutput(): void {
	const log = $("#output-log");
	log.replaceChildren();
}

export function updateSummary(summary: string): void {
	const el = $("#workflow-summary");
	el.textContent = summary;
}

export function updateFlavor(flavor: string): void {
	const el = $("#workflow-flavor");
	el.textContent = flavor;
}
