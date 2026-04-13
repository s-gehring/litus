import type { FeedbackEntry, Workflow } from "./types";

const HEADER = "## USER FEEDBACK (authoritative — overrides spec/plan on any conflict)";

function formatEntry(entry: FeedbackEntry): string {
	const outcomeLabel = entry.outcome ? entry.outcome.value : "in progress";
	const header = `Iteration ${entry.iteration} [${entry.submittedAt}, submitted at ${entry.submittedAtStepName}, outcome: ${outcomeLabel}]:`;
	const quoted = entry.text
		.split(/\r?\n/)
		.map((line) => `> ${line}`)
		.join("\n");
	return `${header}\n${quoted}`;
}

/**
 * Build the feedback-context block injected into every CLI-spawned step prompt.
 * Returns "" when the workflow has no feedback entries.
 */
export function buildFeedbackContext(workflow: Workflow): string {
	if (workflow.feedbackEntries.length === 0) return "";
	const body = workflow.feedbackEntries.map(formatEntry).join("\n\n");
	return `${HEADER}\n\n${body}`;
}
