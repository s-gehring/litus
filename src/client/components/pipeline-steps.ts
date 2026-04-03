import type { PipelineStepStatus, WorkflowState } from "../../types";

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

const STATUS_CLASS: Record<PipelineStepStatus, string> = {
	pending: "step-pending",
	running: "step-running",
	waiting_for_input: "step-waiting",
	completed: "step-completed",
	error: "step-error",
};

export function renderPipelineSteps(workflow: WorkflowState | null): void {
	const container = $("#pipeline-steps");
	if (!container) return;

	if (!workflow || workflow.steps.length === 0) {
		container.classList.add("hidden");
		return;
	}

	container.classList.remove("hidden");
	container.replaceChildren();

	for (let i = 0; i < workflow.steps.length; i++) {
		const step = workflow.steps[i];
		const el = document.createElement("div");
		el.className = `pipeline-step ${STATUS_CLASS[step.status]}`;
		if (i === workflow.currentStepIndex) {
			el.classList.add("step-current");
		}

		const label = document.createElement("span");
		label.className = "step-label";
		label.textContent = step.displayName;
		el.appendChild(label);

		// Review iteration badge
		if (step.name === "review" && workflow.reviewCycle.iteration > 1) {
			const badge = document.createElement("span");
			badge.className = "review-badge";
			badge.textContent = `×${workflow.reviewCycle.iteration}`;
			el.appendChild(badge);
		}

		container.appendChild(el);
	}
}
