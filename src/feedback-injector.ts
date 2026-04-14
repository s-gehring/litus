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

export interface BuildFeedbackContextOptions {
	/**
	 * When true, the in-flight feedback entry (the last one with outcome=null)
	 * is excluded from the generated block. Used by the feedback-implementer
	 * prompt: the agent already receives the current iteration via
	 * ${latestFeedbackText}, and re-labelling it "in progress" here would
	 * duplicate the same text under two headers in the agent's own prompt.
	 */
	excludeInFlight?: boolean;
}

/**
 * Build the feedback-context block injected into every CLI-spawned step prompt.
 * Returns "" when there are no entries to include.
 */
export function buildFeedbackContext(
	workflow: Workflow,
	options: BuildFeedbackContextOptions = {},
): string {
	let entries = workflow.feedbackEntries;
	if (options.excludeInFlight) {
		entries = entries.filter((e) => e.outcome !== null);
	}
	if (entries.length === 0) return "";
	const body = entries.map(formatEntry).join("\n\n");
	return `${HEADER}\n\n${body}`;
}
