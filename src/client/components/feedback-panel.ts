import type { FeedbackEntry, FeedbackOutcomeValue, WorkflowState } from "../../types";
import { $ } from "../dom";

const OUTCOME_LABELS: Record<FeedbackOutcomeValue, string> = {
	success: "success",
	"no changes": "no changes",
	failed: "failed",
	cancelled: "cancelled",
};

const OUTCOME_CLASSES: Record<FeedbackOutcomeValue, string> = {
	success: "outcome-success",
	"no changes": "outcome-no-changes",
	failed: "outcome-failed",
	cancelled: "outcome-cancelled",
};

export function showFeedbackPanel(workflow: WorkflowState, onSubmit: (text: string) => void): void {
	const panel = $("#feedback-panel");
	const input = $("#feedback-input") as HTMLTextAreaElement;
	const submitBtn = $("#btn-submit-feedback") as HTMLButtonElement;
	const cancelBtn = $("#btn-cancel-feedback") as HTMLButtonElement;

	renderFeedbackHistory(workflow.feedbackEntries);

	const hasInFlight = workflow.feedbackEntries.some((e) => e.outcome === null);
	submitBtn.disabled = hasInFlight;
	submitBtn.title = hasInFlight ? "A feedback iteration is already in progress" : "";

	input.value = "";
	panel.classList.remove("hidden");
	input.focus();

	const submitHandler = () => {
		if (submitBtn.disabled) return;
		const text = input.value.trim();
		onSubmit(text);
		hideFeedbackPanel();
	};
	const cancelHandler = () => {
		hideFeedbackPanel();
	};

	// Replace handlers to avoid duplicate bindings
	submitBtn.onclick = submitHandler;
	cancelBtn.onclick = cancelHandler;
	input.onkeydown = (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			submitHandler();
		}
	};
}

export function hideFeedbackPanel(): void {
	const panel = $("#feedback-panel");
	panel.classList.add("hidden");
}

export function renderFeedbackHistory(entries: FeedbackEntry[]): void {
	const container = $("#feedback-history");
	container.replaceChildren();

	if (entries.length === 0) {
		const empty = document.createElement("div");
		empty.className = "feedback-history-empty";
		empty.textContent = "No previous feedback for this workflow.";
		container.appendChild(empty);
		return;
	}

	for (const entry of entries) {
		container.appendChild(renderFeedbackEntry(entry));
	}
}

function renderFeedbackEntry(entry: FeedbackEntry): HTMLDivElement {
	const wrapper = document.createElement("div");
	wrapper.className = "feedback-entry";

	const header = document.createElement("div");
	header.className = "feedback-entry-header";

	const iter = document.createElement("span");
	iter.className = "feedback-entry-iter";
	iter.textContent = `#${entry.iteration}`;
	header.appendChild(iter);

	const ts = document.createElement("span");
	ts.className = "feedback-entry-timestamp";
	ts.textContent = entry.submittedAt;
	header.appendChild(ts);

	const badge = document.createElement("span");
	if (entry.outcome) {
		badge.className = `feedback-entry-outcome ${OUTCOME_CLASSES[entry.outcome.value]}`;
		badge.textContent = OUTCOME_LABELS[entry.outcome.value];
	} else {
		badge.className = "feedback-entry-outcome outcome-pending";
		badge.textContent = "pending";
	}
	header.appendChild(badge);

	wrapper.appendChild(header);

	const text = document.createElement("div");
	text.className = "feedback-entry-text";
	text.textContent = entry.text;
	wrapper.appendChild(text);

	if (entry.outcome?.summary) {
		const summary = document.createElement("div");
		summary.className = "feedback-entry-summary";
		summary.textContent = entry.outcome.summary;
		wrapper.appendChild(summary);
	}

	if (entry.outcome?.warnings && entry.outcome.warnings.length > 0) {
		const warnings = document.createElement("div");
		warnings.className = "feedback-entry-warnings";
		for (const w of entry.outcome.warnings) {
			const line = document.createElement("div");
			line.className = "feedback-entry-warning";
			line.textContent = `${w.kind}: ${w.message}`;
			warnings.appendChild(line);
		}
		wrapper.appendChild(warnings);
	}

	return wrapper;
}
