import { describe, expect, test } from "bun:test";
import type { CLIRunner } from "../../src/cli-runner";
import { CLIStepRunner } from "../../src/cli-step-runner";
import { STEP } from "../../src/pipeline-steps";
import { makeWorkflow } from "../helpers";

function runAndComplete(
	runner: CLIStepRunner,
	step: {
		status: "pending" | "running" | "completed" | "error" | "waiting_for_input" | "paused";
		output: string;
		error: string | null;
		startedAt: string | null;
		completedAt: string | null;
	},
	output: string,
	finalStatus: "completed" | "error",
): void {
	runner.resetStep(step as never);
	step.output = output;
	step.status = finalStatus;
	step.completedAt = new Date().toISOString();
}

describe("pipeline review loop history preservation", () => {
	test("two Reviewing runs preserve the first run as history[0]", () => {
		const runner = new CLIStepRunner({
			start() {},
			resume() {},
			kill() {},
		} as unknown as CLIRunner);
		const workflow = makeWorkflow();
		const reviewIdx = workflow.steps.findIndex((s) => s.name === STEP.REVIEW);
		expect(reviewIdx).toBeGreaterThanOrEqual(0);
		const reviewStep = workflow.steps[reviewIdx];

		runAndComplete(runner, reviewStep, "REVIEW OUTPUT #1 — critical issues found", "completed");
		// Route back into Reviewing: orchestrator calls resetStep → archives run 1
		runAndComplete(runner, reviewStep, "REVIEW OUTPUT #2 — all clear", "completed");

		expect(reviewStep.history).toHaveLength(1);
		expect(reviewStep.history[0].runNumber).toBe(1);
		expect(reviewStep.history[0].status).toBe("completed");
		expect(reviewStep.history[0].output).toBe("REVIEW OUTPUT #1 — critical issues found");
		// Current-run output is the second pass only
		expect(reviewStep.output).toBe("REVIEW OUTPUT #2 — all clear");
	});

	test("merge-pr re-entry after conflict resolution archives the first attempt", () => {
		const runner = new CLIStepRunner({
			start() {},
			resume() {},
			kill() {},
		} as unknown as CLIRunner);
		const workflow = makeWorkflow();
		const mergeIdx = workflow.steps.findIndex((s) => s.name === STEP.MERGE_PR);
		const mergeStep = workflow.steps[mergeIdx];

		runAndComplete(runner, mergeStep, "conflict during merge", "error");
		runAndComplete(runner, mergeStep, "merged cleanly", "completed");

		expect(mergeStep.history).toHaveLength(1);
		expect(mergeStep.history[0].status).toBe("error");
		expect(mergeStep.history[0].output).toBe("conflict during merge");
		expect(mergeStep.output).toBe("merged cleanly");
	});
});
