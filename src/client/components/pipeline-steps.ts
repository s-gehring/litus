import type { PipelineStepName, PipelineStepStatus } from "../../pipeline-steps";
import type { ArtifactDescriptor, WorkflowState } from "../../types";
import { $ } from "../dom";
import { openArtifactViewer } from "./artifact-viewer";

const STATUS_CLASS: Record<PipelineStepStatus, string> = {
	pending: "step-pending",
	running: "step-running",
	waiting_for_input: "step-waiting",
	paused: "step-paused",
	completed: "step-completed",
	error: "step-error",
};

export interface PipelineStepsArtifactContext {
	workflowId: string;
	byStep: Map<PipelineStepName, ArtifactDescriptor[]>;
}

function openDropdown(
	anchor: HTMLElement,
	items: ArtifactDescriptor[],
	onSelect: (descriptor: ArtifactDescriptor) => void,
): void {
	// Close any existing
	for (const el of document.querySelectorAll(".artifact-dropdown")) el.remove();
	const menu = document.createElement("div");
	menu.className = "artifact-dropdown";
	menu.setAttribute("role", "menu");
	const rect = anchor.getBoundingClientRect();
	menu.style.position = "fixed";
	menu.style.top = `${rect.bottom + 4}px`;
	menu.style.left = `${rect.left}px`;
	const buttons: HTMLButtonElement[] = [];
	for (const d of items) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "artifact-dropdown-item";
		btn.setAttribute("role", "menuitem");
		// Artifacts-step entries carry an LLM-provided description. Render it on
		// a second line so the dropdown surfaces what each file actually is.
		const labelEl = document.createElement("span");
		labelEl.className = "artifact-dropdown-label";
		labelEl.textContent = d.displayLabel;
		btn.appendChild(labelEl);
		if (d.step === "artifacts" && d.description) {
			const descEl = document.createElement("span");
			descEl.className = "artifact-dropdown-description";
			descEl.textContent = d.description;
			btn.appendChild(descEl);
		}
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			menu.remove();
			document.removeEventListener("keydown", onKey);
			onSelect(d);
		});
		menu.appendChild(btn);
		buttons.push(btn);
	}
	document.body.appendChild(menu);
	const onKey = (e: KeyboardEvent) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape") return;
		if (e.key === "Escape") {
			menu.remove();
			document.removeEventListener("keydown", onKey);
			anchor.focus();
			return;
		}
		e.preventDefault();
		const active = document.activeElement as HTMLElement | null;
		const idx = active ? buttons.indexOf(active as HTMLButtonElement) : -1;
		const next =
			e.key === "ArrowDown"
				? buttons[(idx + 1 + buttons.length) % buttons.length]
				: buttons[(idx - 1 + buttons.length) % buttons.length];
		next?.focus();
	};
	document.addEventListener("keydown", onKey);
	buttons[0]?.focus();
	const dismiss = (e: MouseEvent) => {
		if (!menu.contains(e.target as Node)) {
			menu.remove();
			document.removeEventListener("mousedown", dismiss);
			document.removeEventListener("keydown", onKey);
		}
	};
	setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
}

function renderArtifactAffordance(
	workflowId: string,
	descriptors: ArtifactDescriptor[],
): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "artifact-affordance";
	btn.textContent = "📄";
	const label = "Artifacts";
	btn.title = label;
	btn.setAttribute("aria-label", label);
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		openDropdown(btn, descriptors, (descriptor) => {
			openArtifactViewer({ workflowId, descriptor, triggerEl: btn });
		});
	});
	return btn;
}

export function renderPipelineSteps(
	workflow: WorkflowState | null,
	selectedIndex?: number | null,
	onStepClick?: (index: number) => void,
	artifacts?: PipelineStepsArtifactContext | null,
): void {
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
		if (selectedIndex === i) {
			el.classList.add("step-selected");
		}

		if (onStepClick && step.status !== "pending") {
			el.style.cursor = "pointer";
			el.addEventListener("click", () => onStepClick(i));
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

		// CI fix attempt badge
		if (step.name === "fix-ci" && workflow.ciCycle.attempt > 0) {
			const badge = document.createElement("span");
			badge.className = "review-badge";
			badge.textContent = `${workflow.ciCycle.attempt}/${workflow.ciCycle.maxAttempts}`;
			el.appendChild(badge);
		}

		// Artifacts outcome annotation — distinguishes "completed with files"
		// from "completed but the LLM produced no artifacts" so a user glancing
		// at the pipeline can tell them apart without drilling into the step.
		if (step.name === "artifacts" && step.status === "completed") {
			const outcome = step.outcome;
			if (outcome === "empty") {
				const badge = document.createElement("span");
				badge.className = "artifacts-outcome-empty";
				badge.textContent = "(no files)";
				el.appendChild(badge);
			}
		}

		// Artifact affordance (only when ≥1 descriptor exists for this step)
		if (artifacts) {
			const descriptors = artifacts.byStep.get(step.name);
			if (descriptors && descriptors.length > 0) {
				el.appendChild(renderArtifactAffordance(artifacts.workflowId, descriptors));
			}
		}

		container.appendChild(el);
	}
}
