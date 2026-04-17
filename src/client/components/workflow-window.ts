import type {
	EpicStatus,
	FeedbackEntry,
	FeedbackOutcomeValue,
	OutputEntry,
	ToolUsage,
	WorkflowState,
} from "../../types";
import { $ } from "../dom";
import { renderMarkdown } from "../render-markdown";

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
	} else if (stepLabel) {
		stepLabel.classList.add("hidden");
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

function pinThinkingIndicatorToTail(log: HTMLElement): void {
	const el = log.querySelector(".thinking-indicator");
	if (el && el !== log.lastElementChild) log.appendChild(el);
}

export function appendOutput(text: string, type: "normal" | "error" | "system" = "normal"): void {
	const log = $("#output-log");
	const line = document.createElement("div");
	line.className = `output-line ${type}`;
	line.textContent = text;
	log.appendChild(line);
	pinThinkingIndicatorToTail(log);
	log.scrollTop = log.scrollHeight;
}

// Thinking indicator: small animated marker at the tail of the active step's
// output while LLM tokens are streaming. A hide debounce absorbs sub-second
// tool-call gaps so the indicator does not flicker during tool use.

const THINKING_HIDE_DEBOUNCE_MS = 400;
let thinkingHideTimer: ReturnType<typeof setTimeout> | null = null;

function getOrCreateThinkingIndicator(): HTMLElement {
	const log = $("#output-log");
	let el = log.querySelector<HTMLElement>(".thinking-indicator");
	if (!el) {
		el = document.createElement("div");
		el.className = "thinking-indicator";
		el.setAttribute("aria-label", "Agent is thinking");
		el.innerHTML =
			'<span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>';
		log.appendChild(el);
	} else {
		// Always keep the indicator pinned at the tail so new output lines
		// push it down rather than orphaning it mid-log.
		log.appendChild(el);
	}
	return el;
}

export function showThinkingIndicator(): void {
	if (thinkingHideTimer) {
		clearTimeout(thinkingHideTimer);
		thinkingHideTimer = null;
	}
	const el = getOrCreateThinkingIndicator();
	el.classList.add("visible");
	const log = $("#output-log");
	log.scrollTop = log.scrollHeight;
}

export function scheduleHideThinkingIndicator(): void {
	if (thinkingHideTimer) clearTimeout(thinkingHideTimer);
	thinkingHideTimer = setTimeout(() => {
		thinkingHideTimer = null;
		removeThinkingIndicator();
	}, THINKING_HIDE_DEBOUNCE_MS);
}

export function removeThinkingIndicator(): void {
	if (thinkingHideTimer) {
		clearTimeout(thinkingHideTimer);
		thinkingHideTimer = null;
	}
	const log = $("#output-log");
	const el = log.querySelector(".thinking-indicator");
	if (el) el.remove();
}

// Per-field tooltip line caps. Typical content must never be abbreviated;
// caps only kick in for outliers.

export const TOOLTIP_FIELD_CAPS: {
	commandOrArgument: number;
	writeBody: number;
} = {
	commandOrArgument: 30,
	writeBody: 15,
};

export interface AbbreviationResult {
	text: string;
	truncated: boolean;
	remaining: number;
}

export function abbreviateField(content: string, cap: number | null): AbbreviationResult {
	if (cap === null) return { text: content, truncated: false, remaining: 0 };
	const lines = content.split("\n");
	if (lines.length <= cap) return { text: content, truncated: false, remaining: 0 };
	const kept = lines.slice(0, cap).join("\n");
	const remaining = lines.length - cap;
	return {
		text: `${kept}\n… (${remaining} more line${remaining === 1 ? "" : "s"})`,
		truncated: true,
		remaining,
	};
}

// Fields treated as "command/argument" (natural-language or code payload):
// apply the generous ~30-line cap.
const COMMAND_LIKE_FIELDS = new Set([
	"command",
	"pattern",
	"query",
	"prompt",
	"old_string",
	"new_string",
]);

// Fields treated as "Write body" (file content being written): ~15-line cap.
// Edit's old_string/new_string fall through to COMMAND_LIKE_FIELDS above.
const WRITE_BODY_FIELDS: Record<string, Set<string>> = {
	Write: new Set(["content"]),
	write_file: new Set(["content"]),
};

function capFor(toolName: string, fieldKey: string): number | null {
	if (WRITE_BODY_FIELDS[toolName]?.has(fieldKey)) return TOOLTIP_FIELD_CAPS.writeBody;
	if (COMMAND_LIKE_FIELDS.has(fieldKey)) return TOOLTIP_FIELD_CAPS.commandOrArgument;
	return null; // uncapped (paths, metadata, etc.)
}

export function formatToolInput(toolName: string, input: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null) continue;
		const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
		const { text } = abbreviateField(raw, capFor(toolName, key));
		lines.push(`${key}: ${text}`);
	}
	return lines.join("\n");
}

function positionTooltip(anchor: HTMLElement, tooltip: HTMLElement): void {
	// Position tooltips relative to the viewport so clipping ancestors cannot
	// hide them, and flip/shift to stay inside the window. When neither side
	// fits, pick the side with more space and clamp to the window edge.
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const anchorRect = anchor.getBoundingClientRect();

	tooltip.style.left = "0px";
	tooltip.style.top = "0px";
	tooltip.style.maxWidth = `${Math.min(400, vw - 8)}px`;

	const tipRect = tooltip.getBoundingClientRect();
	const gap = 6;
	const spaceBelow = vh - anchorRect.bottom - gap;
	const spaceAbove = anchorRect.top - gap;
	const placeBelow = tipRect.height <= spaceBelow || spaceBelow >= spaceAbove;
	let top = placeBelow ? anchorRect.bottom + gap : anchorRect.top - gap - tipRect.height;
	top = Math.max(4, Math.min(top, vh - tipRect.height - 4));

	let left = anchorRect.left + anchorRect.width / 2 - tipRect.width / 2;
	left = Math.max(4, Math.min(left, vw - tipRect.width - 4));

	tooltip.style.left = `${left}px`;
	tooltip.style.top = `${top}px`;
}

function renderToolIcons(tools: ToolUsage[]): HTMLDivElement {
	const row = document.createElement("div");
	row.className = "tool-icons";
	for (const usage of tools) {
		const mapping = TOOL_ICONS[usage.name] ?? {
			icon: FALLBACK_ICON.icon,
			label: usage.name || FALLBACK_ICON.label,
		};
		const wrapper = document.createElement("span");
		wrapper.className = "tool-icon-wrapper";

		const badge = document.createElement("span");
		badge.className = "tool-icon";
		badge.textContent = mapping.icon;

		const tooltip = document.createElement("div");
		tooltip.className = "tool-tooltip";
		let tooltipText = mapping.label;
		if (usage.input && Object.keys(usage.input).length > 0) {
			tooltipText += `\n${formatToolInput(usage.name, usage.input)}`;
		}
		tooltip.textContent = tooltipText;

		const show = () => {
			tooltip.classList.add("visible");
			positionTooltip(badge, tooltip);
		};
		const hide = () => {
			tooltip.classList.remove("visible");
		};
		wrapper.addEventListener("mouseenter", show);
		wrapper.addEventListener("focusin", show);
		wrapper.addEventListener("mouseleave", hide);
		wrapper.addEventListener("focusout", hide);

		wrapper.appendChild(badge);
		wrapper.appendChild(tooltip);
		row.appendChild(wrapper);
	}
	return row;
}

function lastNonSystemLine(log: HTMLElement): HTMLElement | null {
	// Iterate explicitly: `:last-of-type` binds to the tag name, so a pinned
	// thinking-indicator div at the tail would mask the last `.output-line`.
	const lines = log.querySelectorAll<HTMLElement>(".output-line");
	const last = lines.item(lines.length - 1);
	if (last && !last.classList.contains("system")) return last;
	return null;
}

export function appendToolIcons(tools: ToolUsage[]): void {
	const log = $("#output-log");
	// Never attach tool icons to an italic step-header (.system) line — they'd
	// inherit the italic styling. Start a fresh normal line when the last
	// existing line is a system/header line.
	let target = lastNonSystemLine(log);
	if (!target) {
		target = document.createElement("div");
		target.className = "output-line normal";
		log.appendChild(target);
	}
	target.appendChild(renderToolIcons(tools));
	pinThinkingIndicatorToTail(log);
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
			// Attach to the last non-system output-line so tool icons never
			// inherit italic styling from a step header.
			let target = lastNonSystemLine(log);
			if (!target) {
				target = document.createElement("div");
				target.className = "output-line normal";
				log.appendChild(target);
			}
			target.appendChild(renderToolIcons(entry.tools));
		}
	}
	log.scrollTop = log.scrollHeight;
}

export function clearOutput(): void {
	const log = $("#output-log");
	if (thinkingHideTimer) {
		clearTimeout(thinkingHideTimer);
		thinkingHideTimer = null;
	}
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

function createBranchInfoItem(label: string, value: string): HTMLSpanElement {
	const item = document.createElement("span");
	item.className = "branch-info-item";

	const labelEl = document.createElement("span");
	labelEl.className = "branch-info-label";
	labelEl.textContent = label;

	const valueEl = document.createElement("span");
	valueEl.className = "branch-info-value";
	valueEl.textContent = value;

	item.appendChild(labelEl);
	item.append(" ");
	item.appendChild(valueEl);
	return item;
}

export function updateBranchInfo(workflow: WorkflowState | null): void {
	const el = $("#branch-info");
	if (!el) return;

	if (!workflow) {
		el.classList.add("hidden");
		el.innerHTML = "";
		return;
	}

	const branch = workflow.featureBranch ?? workflow.worktreeBranch;
	const worktree = workflow.worktreePath;

	el.innerHTML = "";

	if (branch) {
		const item = createBranchInfoItem("Branch:", branch);
		el.appendChild(item);
	}
	if (worktree) {
		const item = createBranchInfoItem("Worktree:", worktree);
		el.appendChild(item);
	}

	if (el.childElementCount > 0) {
		el.classList.remove("hidden");
	} else {
		el.classList.add("hidden");
	}
}

export type ActiveModelPanelMode =
	| { kind: "hidden" }
	| { kind: "workflow"; workflow: WorkflowState }
	| { kind: "epic-analysis"; model: string; effort: string | null };

function capitalize(value: string): string {
	if (!value) return value;
	return value.charAt(0).toUpperCase() + value.slice(1);
}

let defaultModelDisplayName: string | null = null;

export function setDefaultModelDisplayName(name: string | null): void {
	defaultModelDisplayName = name?.trim() ? name.trim() : null;
}

function formatModelEffort(model: string, effort: string | null): string {
	const trimmed = model.trim();
	const isDefault = !trimmed || trimmed.toLowerCase() === "default";
	let modelLabel: string;
	if (isDefault) {
		modelLabel = defaultModelDisplayName ? `Default (${defaultModelDisplayName})` : "Default";
	} else {
		modelLabel = capitalize(trimmed);
	}
	const effortLabel = capitalize(effort ?? "default");
	return `Model: ${modelLabel} - Effort: ${effortLabel}`;
}

export function updateActiveModelPanel(mode: ActiveModelPanelMode): void {
	const panel = $("#active-model-panel");
	if (!panel) return;

	panel.classList.remove("paused");

	if (mode.kind === "hidden") {
		panel.classList.add("hidden");
		panel.classList.remove("empty");
		panel.textContent = "";
		return;
	}

	panel.classList.remove("hidden");

	if (mode.kind === "epic-analysis") {
		panel.classList.remove("empty");
		panel.textContent = formatModelEffort(mode.model, mode.effort);
		return;
	}

	const { workflow } = mode;
	const invocation = workflow.activeInvocation;

	if (!invocation) {
		panel.textContent = "No model in use";
		panel.classList.add("empty");
		return;
	}

	panel.classList.remove("empty");
	let text = formatModelEffort(invocation.model, invocation.effort);
	if (workflow.status === "paused") {
		text += " — paused, not live";
		panel.classList.add("paused");
	}
	panel.textContent = text;
}

export function updateUserInput(text: string): void {
	const el = $("#user-input");
	if (!el) return;

	if (text) {
		el.innerHTML = renderMarkdown(text);
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

const FEEDBACK_OUTCOME_CLASSES: Record<FeedbackOutcomeValue, string> = {
	success: "outcome-success",
	"no changes": "outcome-no-changes",
	failed: "outcome-failed",
	cancelled: "outcome-cancelled",
};

const FEEDBACK_PREVIEW_MAX_CHARS = 140;

function truncateText(text: string, max = FEEDBACK_PREVIEW_MAX_CHARS): string {
	// Collapse newlines so multi-line feedback shows a compact single-line preview.
	const collapsed = text.replace(/\r?\n+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function formatFeedbackTimestamp(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function updateFeedbackHistorySection(entries: FeedbackEntry[]): void {
	const section = $("#workflow-feedback-section");
	if (!section) return;

	if (entries.length === 0) {
		section.classList.add("hidden");
		section.replaceChildren();
		return;
	}

	section.classList.remove("hidden");
	section.replaceChildren();

	const header = document.createElement("div");
	header.className = "workflow-feedback-header";
	header.textContent = `Feedback history (${entries.length})`;
	section.appendChild(header);

	for (const entry of entries) {
		section.appendChild(renderFeedbackHistoryEntry(entry));
	}
}

function renderFeedbackHistoryEntry(entry: FeedbackEntry): HTMLDivElement {
	const row = document.createElement("div");
	row.className = "workflow-feedback-entry";

	const head = document.createElement("div");
	head.className = "workflow-feedback-entry-head";

	const iter = document.createElement("span");
	iter.className = "workflow-feedback-entry-iter";
	iter.textContent = `#${entry.iteration}`;
	head.appendChild(iter);

	const ts = document.createElement("span");
	ts.className = "workflow-feedback-entry-timestamp";
	ts.textContent = formatFeedbackTimestamp(entry.submittedAt);
	ts.title = entry.submittedAt;
	head.appendChild(ts);

	const badge = document.createElement("span");
	if (entry.outcome) {
		badge.className = `workflow-feedback-entry-outcome ${FEEDBACK_OUTCOME_CLASSES[entry.outcome.value]}`;
		badge.textContent = entry.outcome.value;
	} else {
		badge.className = "workflow-feedback-entry-outcome outcome-pending";
		badge.textContent = "pending";
	}
	head.appendChild(badge);

	row.appendChild(head);

	const preview = document.createElement("div");
	preview.className = "workflow-feedback-entry-preview";
	preview.textContent = truncateText(entry.text);
	row.appendChild(preview);

	if (entry.outcome?.summary) {
		const summary = document.createElement("div");
		summary.className = "workflow-feedback-entry-summary";
		summary.textContent = entry.outcome.summary;
		row.appendChild(summary);
	}

	if (entry.outcome?.warnings && entry.outcome.warnings.length > 0) {
		for (const w of entry.outcome.warnings) {
			const warn = document.createElement("div");
			warn.className = "workflow-feedback-entry-warning";
			warn.textContent = `${w.kind}: ${w.message}`;
			row.appendChild(warn);
		}
	}

	return row;
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
