import { describe, expect, test } from "bun:test";
import { recoverInterruptedFeedbackImplementer } from "../../src/feedback-implementer";
import { STEP } from "../../src/types";
import { makeWorkflow } from "../helpers";

describe("recoverInterruptedFeedbackImplementer archive behavior", () => {
	test("archives the interrupted FI run with status 'paused' and clears live fields", () => {
		const workflow = makeWorkflow({ status: "running" });
		const fiIdx = workflow.steps.findIndex((s) => s.name === STEP.FEEDBACK_IMPLEMENTER);
		const fiStep = workflow.steps[fiIdx];

		fiStep.status = "running";
		fiStep.output = "FI run 1 — interrupted by restart";
		fiStep.startedAt = "2026-04-18T12:00:00.000Z";
		fiStep.completedAt = null;

		const mergeIdx = workflow.steps.findIndex((s) => s.name === STEP.MERGE_PR);
		workflow.currentStepIndex = fiIdx;
		workflow.steps[mergeIdx].status = "completed";

		recoverInterruptedFeedbackImplementer(workflow);

		expect(fiStep.history).toHaveLength(1);
		expect(fiStep.history[0].status).toBe("paused");
		expect(fiStep.history[0].output).toBe("FI run 1 — interrupted by restart");
		expect(fiStep.output).toBe("");
		expect(fiStep.status as string).toBe("pending");
	});

	test("does not archive when no prior run exists (startedAt null)", () => {
		const workflow = makeWorkflow({ status: "running" });
		const fiIdx = workflow.steps.findIndex((s) => s.name === STEP.FEEDBACK_IMPLEMENTER);
		const fiStep = workflow.steps[fiIdx];

		fiStep.status = "pending";
		fiStep.output = "";
		fiStep.startedAt = null;

		const mergeIdx = workflow.steps.findIndex((s) => s.name === STEP.MERGE_PR);
		workflow.currentStepIndex = fiIdx;
		workflow.steps[mergeIdx].status = "completed";

		recoverInterruptedFeedbackImplementer(workflow);

		expect(fiStep.history).toHaveLength(0);
	});
});
