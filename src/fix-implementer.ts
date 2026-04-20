import type { FeedbackEntry, Workflow } from "./types";

export const FIX_IMPLEMENT_EMPTY_DIFF_MESSAGE = "no changes produced";
export const FIX_IMPLEMENT_HEAD_READ_FAILED_MESSAGE = "failed to read git HEAD after fix-implement";

/**
 * Build the prompt for the `fix-implement` step. Uses the workflow's
 * `specification` (the user's fix description) as the primary instruction and
 * appends any in-flight feedback entry text as retry context.
 */
export function buildFixImplementPrompt(workflow: Workflow): string {
	const lines: string[] = [];
	lines.push("You are implementing a small, self-contained fix in this repository.");
	lines.push("");
	lines.push("Fix description:");
	lines.push(workflow.specification.trim());

	const pending = findPendingFeedback(workflow);
	if (pending) {
		lines.push("");
		lines.push("Additional guidance from the user:");
		lines.push(pending.text.trim());
	}

	lines.push("");
	lines.push("Requirements:");
	lines.push("- Implement the fix directly in the current worktree.");
	lines.push("- Make one or more atomic git commits describing the change.");
	lines.push("- Push the commits to the current branch's upstream (create it if needed).");
	lines.push("- If the change is already present, say so explicitly and exit without committing.");
	return lines.join("\n");
}

function findPendingFeedback(workflow: Workflow): FeedbackEntry | null {
	for (let i = workflow.feedbackEntries.length - 1; i >= 0; i--) {
		const entry = workflow.feedbackEntries[i];
		if (entry.outcome === null) return entry;
	}
	return null;
}

export type FixImplementDiffResult =
	| { kind: "changes" }
	| { kind: "empty" }
	| { kind: "head-read-failed" };

/**
 * Classify the pre- and post-run HEAD pair. A null HEAD on either side is a
 * distinct failure mode — the worktree, permissions, or `git rev-parse` itself
 * failed — and must not be silently reported as "no changes produced".
 */
export function classifyFixImplementDiff(
	preRunHead: string | null,
	postRunHead: string | null,
): FixImplementDiffResult {
	if (!preRunHead || !postRunHead) return { kind: "head-read-failed" };
	if (preRunHead === postRunHead) return { kind: "empty" };
	return { kind: "changes" };
}

/**
 * @deprecated Use {@link classifyFixImplementDiff} — this helper conflates
 * git-read failures with a legitimately empty diff. Retained so unit tests and
 * downstream callers can be migrated incrementally.
 */
export function isEmptyDiff(preRunHead: string | null, postRunHead: string | null): boolean {
	return classifyFixImplementDiff(preRunHead, postRunHead).kind !== "changes";
}
