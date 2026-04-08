import type { ReviewSeverity, Workflow } from "./types";
import { STEP } from "./types";

export type RouteDecision =
	| { action: "advance-to-next" }
	| { action: "complete" }
	| { action: "route-to-implement-review" }
	| { action: "route-to-monitor-ci" }
	| { action: "route-to-merge-pr" }
	| { action: "route-to-sync-repo" }
	| { action: "route-back-to-monitor" }
	| { action: "advance-to-fix-ci" }
	| { action: "handle-implement-review-complete" }
	| { action: "handle-merge-result" };

/**
 * Determine the next routing action after a step completes.
 * Pure function — reads workflow state, returns a decision, never mutates.
 */
export function routeAfterStep(workflow: Workflow): RouteDecision {
	const step = workflow.steps[workflow.currentStepIndex];

	switch (step.name) {
		case STEP.COMMIT_PUSH_PR:
			return { action: "route-to-monitor-ci" };

		case STEP.MONITOR_CI:
			return { action: "route-to-merge-pr" };

		case STEP.FIX_CI:
			return { action: "route-back-to-monitor" };

		case STEP.MERGE_PR:
			return { action: "route-to-sync-repo" };

		case STEP.SYNC_REPO:
			return { action: "complete" };

		case STEP.REVIEW:
			return { action: "route-to-implement-review" };

		case STEP.IMPLEMENT_REVIEW:
			return { action: "handle-implement-review-complete" };

		default:
			return { action: "advance-to-next" };
	}
}

/**
 * Parse review output to extract a severity keyword.
 * Looks for severity keywords (case-insensitive) in the output text.
 */
export function classifyReviewSeverity(output: string): ReviewSeverity {
	const upper = output.toUpperCase();
	if (upper.includes("CRITICAL")) return "critical";
	if (upper.includes("MAJOR")) return "major";
	if (upper.includes("MINOR")) return "minor";
	if (upper.includes("TRIVIAL")) return "trivial";
	if (upper.includes("NIT")) return "nit";
	return "minor";
}

/**
 * Decide whether the review cycle should loop back for another iteration.
 * Only critical and major severities trigger a loop, and only if under the max.
 */
export function shouldLoopReview(
	severity: ReviewSeverity,
	iteration: number,
	maxIterations: number,
): boolean {
	return (severity === "critical" || severity === "major") && iteration < maxIterations;
}
