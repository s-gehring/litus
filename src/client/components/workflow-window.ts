import { marked } from "marked";
import type { EpicStatus, OutputEntry, WorkflowState } from "../../types";

marked.setOptions({ async: false, breaks: true });

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

export const TOOL_ICONS: Record<string, { icon: string; label: string }> = {
	Agent: { icon: "🤖", label: "Agent" },
	Bash: { icon: "⚡", label: "Bash" },
	Edit: { icon: "✏️", label: "Edit" },
	Glob: { icon: "📂", label: "Glob" },
	Grep: { icon: "🔍", label: "Grep" },
	Read: { icon: "📄", label: "Read" },
	Write: { icon: "💾", label: "Write" },
	TodoWrite: { icon: "✅", label: "TodoWrite" },
	ToolSearch: { icon: "🔧", label: "ToolSearch" },
	write_file: { icon: "📝", label: "write_file" },
};

export const FALLBACK_ICON = { icon: "⚙️", label: "Tool" };

export function updateWorkflowStatus(workflow: WorkflowState | null): void {
	const statusBadge = $("#workflow-status");
	const status = workflow?.status || "idle";

	statusBadge.textContent = status.replaceAll("_", " ");
	statusBadge.className = `status-badge ${status}`;

	// Show current step name in status area
	const stepLabel = $("#current-step-label");
	const isActive = status === "running" || status === "waiting_for_input";
	if (stepLabel && workflow && workflow.steps.length > 0) {
		const currentStep = workflow.steps[workflow.currentStepIndex];
		if (currentStep && isActive) {
			stepLabel.textContent = currentStep.displayName;
			stepLabel.classList.remove("hidden");
		} else {
			stepLabel.classList.add("hidden");
		}
	}

	// PR link
	const prLink = $("#pr-link") as HTMLAnchorElement | null;
	if (prLink) {
		if (workflow?.prUrl) {
			prLink.href = workflow.prUrl;
			prLink.textContent = "View PR";
			prLink.classList.remove("hidden");
		} else {
			prLink.classList.add("hidden");
		}
	}
}

const EPIC_STATUS_MAP: Record<EpicStatus, { label: string; css: string }> = {
	analyzing: { label: "Analyzing Epic", css: "running" },
	completed: { label: "completed", css: "completed" },
	error: { label: "error", css: "error" },
	infeasible: { label: "infeasible", css: "error" },
};

export function updateEpicStatus(status: EpicStatus): void {
	const statusBadge = $("#workflow-status");
	const stepLabel = $("#current-step-label");
	const prLink = $("#pr-link") as HTMLAnchorElement | null;

	const mapped = EPIC_STATUS_MAP[status];
	statusBadge.textContent = mapped.label;
	statusBadge.className = `status-badge ${mapped.css}`;

	if (stepLabel) stepLabel.classList.add("hidden");
	if (prLink) prLink.classList.add("hidden");
}

export function appendOutput(text: string, type: "normal" | "error" | "system" = "normal"): void {
	const log = $("#output-log");
	const line = document.createElement("div");
	line.className = `output-line ${type}`;
	line.textContent = text;
	log.appendChild(line);
	log.scrollTop = log.scrollHeight;
}

function renderToolIcons(tools: Record<string, number>): HTMLDivElement {
	const row = document.createElement("div");
	row.className = "tool-icons";
	for (const [name, count] of Object.entries(tools)) {
		const mapping = TOOL_ICONS[name] ?? FALLBACK_ICON;
		const badge = document.createElement("span");
		badge.className = "tool-icon";
		badge.textContent = count > 1 ? `${mapping.icon}${count}` : mapping.icon;
		badge.title = count > 1 ? `${mapping.label} x${count}` : mapping.label;
		row.appendChild(badge);
	}
	return row;
}

export function appendToolIcons(tools: Record<string, number>): void {
	const log = $("#output-log");
	// Attach to the last .output-line, or create a minimal one if none exists
	let lastLine = log.querySelector(".output-line:last-of-type") as HTMLElement | null;
	if (!lastLine) {
		lastLine = document.createElement("div");
		lastLine.className = "output-line normal";
		log.appendChild(lastLine);
	}
	lastLine.appendChild(renderToolIcons(tools));
	log.scrollTop = log.scrollHeight;
}

export function renderOutputEntries(entries: OutputEntry[]): void {
	const log = $("#output-log");
	for (const entry of entries) {
		if (entry.kind === "text") {
			const line = document.createElement("div");
			line.className = `output-line ${entry.type ?? "normal"}`;
			line.textContent = entry.text;
			log.appendChild(line);
		} else {
			// tools entry: attach to the last output-line
			let lastLine = log.querySelector(".output-line:last-of-type") as HTMLElement | null;
			if (!lastLine) {
				lastLine = document.createElement("div");
				lastLine.className = "output-line normal";
				log.appendChild(lastLine);
			}
			lastLine.appendChild(renderToolIcons(entry.tools));
		}
	}
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

export function updateStepSummary(stepSummary: string): void {
	const el = $("#workflow-step-summary");
	if (el) el.textContent = stepSummary;
}

export function updateFlavor(flavor: string): void {
	const el = $("#workflow-flavor");
	el.textContent = flavor;
}

export function updateUserInput(text: string): void {
	const el = $("#user-input");
	if (!el) return;

	if (text) {
		el.innerHTML = marked.parse(text) as string;
		el.classList.remove("hidden");
	} else {
		el.innerHTML = "";
		el.classList.add("hidden");
	}
}

export function updateSpecDetails(text: string): void {
	const details = $("#spec-details");
	const textEl = $("#spec-details-text");
	if (!details || !textEl) return;

	if (text) {
		textEl.textContent = text;
		details.classList.remove("hidden");
	} else {
		details.classList.add("hidden");
	}
}

export function updateDetailActions(
	buttons: { label: string; className: string; onClick: () => void }[],
): void {
	const container = $("#detail-actions");
	if (!container) return;

	container.replaceChildren();

	if (buttons.length === 0) {
		container.classList.add("hidden");
		return;
	}

	for (const btn of buttons) {
		const el = document.createElement("button");
		el.className = `btn ${btn.className}`;
		el.textContent = btn.label;
		el.addEventListener("click", btn.onClick);
		container.appendChild(el);
	}
	container.classList.remove("hidden");
}
