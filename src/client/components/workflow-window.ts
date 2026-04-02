import type { WorkflowState } from "../../types";

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

export function updateWorkflowStatus(workflow: WorkflowState | null): void {
	const statusBadge = $("#workflow-status");
	const btnStart = $("#btn-start") as HTMLButtonElement;
	const btnCancel = $("#btn-cancel") as HTMLButtonElement;
	const specInput = $("#specification-input") as HTMLTextAreaElement;

	const status = workflow?.status || "idle";

	// Update status badge
	statusBadge.textContent = status.replace("_", " ");
	statusBadge.className = `status-badge ${status}`;

	// Toggle buttons based on state
	const isActive = status === "running" || status === "waiting_for_input";
	const canStart =
		!workflow ||
		status === "idle" ||
		status === "completed" ||
		status === "cancelled" ||
		status === "error";

	btnStart.classList.toggle("hidden", !canStart);
	btnCancel.classList.toggle("hidden", !isActive);
	specInput.disabled = isActive;

	if (canStart) {
		btnStart.disabled = false;
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
