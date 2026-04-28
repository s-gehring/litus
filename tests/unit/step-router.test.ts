import { describe, expect, test } from "bun:test";
import { STEP } from "../../src/pipeline-steps";
import { type RouteDecision, routeAfterStep, shouldLoopReview } from "../../src/step-router";
import { makeWorkflow } from "../helpers";

// ── routeAfterStep ─────────────────────────────────────────

describe("routeAfterStep", () => {
	function routeAtStep(stepName: string): RouteDecision {
		const workflow = makeWorkflow({ status: "running" });
		const idx = workflow.steps.findIndex((s) => s.name === stepName);
		workflow.currentStepIndex = idx;
		workflow.steps[idx].status = "completed";
		return routeAfterStep(workflow);
	}

	test("after setup → advance-to-next", () => {
		expect(routeAtStep(STEP.SETUP)).toEqual({ action: "advance-to-next" });
	});

	test("after specify → advance-to-next", () => {
		expect(routeAtStep(STEP.SPECIFY)).toEqual({ action: "advance-to-next" });
	});

	test("after review → route-to-implement-review", () => {
		expect(routeAtStep(STEP.REVIEW)).toEqual({ action: "route-to-implement-review" });
	});

	test("after implement-review → handle-implement-review-complete", () => {
		expect(routeAtStep(STEP.IMPLEMENT_REVIEW)).toEqual({
			action: "handle-implement-review-complete",
		});
	});

	test("after commit-push-pr → route-to-monitor-ci", () => {
		expect(routeAtStep(STEP.COMMIT_PUSH_PR)).toEqual({ action: "route-to-monitor-ci" });
	});

	test("after monitor-ci → route-to-merge-pr", () => {
		expect(routeAtStep(STEP.MONITOR_CI)).toEqual({ action: "route-to-merge-pr" });
	});

	test("after fix-ci → route-back-to-monitor", () => {
		expect(routeAtStep(STEP.FIX_CI)).toEqual({ action: "route-back-to-monitor" });
	});

	test("after merge-pr → route-to-sync-repo", () => {
		expect(routeAtStep(STEP.MERGE_PR)).toEqual({ action: "route-to-sync-repo" });
	});

	test("after sync-repo → complete", () => {
		expect(routeAtStep(STEP.SYNC_REPO)).toEqual({ action: "complete" });
	});

	test("default step (e.g. clarify, plan, tasks, implement) → advance-to-next", () => {
		for (const step of [STEP.CLARIFY, STEP.PLAN, STEP.TASKS, STEP.IMPLEMENT]) {
			expect(routeAtStep(step)).toEqual({ action: "advance-to-next" });
		}
	});
});

// ── shouldLoopReview ───────────────────────────────────────

describe("shouldLoopReview", () => {
	test("loops on critical severity when under max iterations", () => {
		expect(shouldLoopReview("critical", 1, 16)).toBe(true);
	});

	test("loops on major severity when under max iterations", () => {
		expect(shouldLoopReview("major", 1, 16)).toBe(true);
	});

	test("does not loop on minor severity", () => {
		expect(shouldLoopReview("minor", 1, 16)).toBe(false);
	});

	test("does not loop on trivial severity", () => {
		expect(shouldLoopReview("trivial", 1, 16)).toBe(false);
	});

	test("does not loop on nit severity", () => {
		expect(shouldLoopReview("nit", 1, 16)).toBe(false);
	});

	test("does not loop when iteration equals max", () => {
		expect(shouldLoopReview("critical", 16, 16)).toBe(false);
	});

	test("does not loop when iteration exceeds max", () => {
		expect(shouldLoopReview("major", 17, 16)).toBe(false);
	});

	test("loops on critical at iteration just below max", () => {
		expect(shouldLoopReview("critical", 15, 16)).toBe(true);
	});
});
