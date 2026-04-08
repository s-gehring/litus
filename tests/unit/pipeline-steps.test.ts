import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderPipelineSteps } from "../../src/client/components/pipeline-steps";
import type { PipelineStepName, PipelineStepStatus, WorkflowState } from "../../src/types";
import { makeWorkflowState } from "../helpers";

function makeStep(
	overrides: Partial<{
		name: PipelineStepName;
		displayName: string;
		status: PipelineStepStatus;
	}> = {},
) {
	return {
		name: overrides.name ?? ("implement" as PipelineStepName),
		displayName: overrides.displayName ?? "Implementing",
		status: overrides.status ?? ("pending" as PipelineStepStatus),
		output: "",
		error: null,
		startedAt: null,
		completedAt: null,
	};
}

function makeWorkflowWithSteps(
	steps: ReturnType<typeof makeStep>[],
	overrides?: Partial<WorkflowState>,
): WorkflowState {
	return makeWorkflowState({ steps, ...overrides });
}

describe("pipeline-steps", () => {
	beforeEach(() => {
		document.body.innerHTML = '<div id="pipeline-steps"></div>';
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	// T009: Each of 6 step statuses maps to correct CSS class
	describe("status CSS class mapping", () => {
		const cases: [PipelineStepStatus, string][] = [
			["pending", "step-pending"],
			["running", "step-running"],
			["completed", "step-completed"],
			["error", "step-error"],
			["waiting_for_input", "step-waiting"],
			["paused", "step-paused"],
		];

		for (const [status, expectedClass] of cases) {
			test(`status "${status}" maps to class "${expectedClass}"`, () => {
				const wf = makeWorkflowWithSteps([makeStep({ status })]);
				renderPipelineSteps(wf);

				const el = document.querySelector(".pipeline-step");
				expect(el?.classList.contains(expectedClass)).toBe(true);
			});
		}
	});

	// T010: Current step has step-current class
	test("current step has step-current class based on currentStepIndex", () => {
		const wf = makeWorkflowWithSteps(
			[
				makeStep({ name: "specify", displayName: "Specify", status: "completed" }),
				makeStep({ name: "plan", displayName: "Plan", status: "running" }),
				makeStep({ name: "implement", displayName: "Implement", status: "pending" }),
			],
			{ currentStepIndex: 1 },
		);
		renderPipelineSteps(wf);

		const steps = document.querySelectorAll(".pipeline-step");
		expect(steps[0].classList.contains("step-current")).toBe(false);
		expect(steps[1].classList.contains("step-current")).toBe(true);
		expect(steps[2].classList.contains("step-current")).toBe(false);
	});

	// T011: Review step badge shows iteration count when > 1
	test("review step badge shows iteration count when reviewCycle.iteration > 1", () => {
		const wf = makeWorkflowWithSteps(
			[makeStep({ name: "review", displayName: "Review", status: "running" })],
			{ reviewCycle: { iteration: 3, maxIterations: 16, lastSeverity: null } },
		);
		renderPipelineSteps(wf);

		const badge = document.querySelector(".review-badge");
		expect(badge).not.toBeNull();
		expect(badge?.textContent).toBe("×3");
	});

	test("review step badge not shown when reviewCycle.iteration is 1", () => {
		const wf = makeWorkflowWithSteps(
			[makeStep({ name: "review", displayName: "Review", status: "running" })],
			{ reviewCycle: { iteration: 1, maxIterations: 16, lastSeverity: null } },
		);
		renderPipelineSteps(wf);

		const badge = document.querySelector(".review-badge");
		expect(badge).toBeNull();
	});

	// T012: Fix-CI step badge shows attempt/maxAttempts when attempt > 0
	test("fix-ci step badge shows attempt/maxAttempts when ciCycle.attempt > 0", () => {
		const wf = makeWorkflowWithSteps(
			[makeStep({ name: "fix-ci", displayName: "Fix CI", status: "running" })],
			{
				ciCycle: {
					attempt: 2,
					maxAttempts: 3,
					monitorStartedAt: null,
					globalTimeoutMs: 0,
					lastCheckResults: [],
					failureLogs: [],
				},
			},
		);
		renderPipelineSteps(wf);

		const badge = document.querySelector(".review-badge");
		expect(badge).not.toBeNull();
		expect(badge?.textContent).toBe("2/3");
	});

	test("fix-ci step badge not shown when ciCycle.attempt is 0", () => {
		const wf = makeWorkflowWithSteps(
			[makeStep({ name: "fix-ci", displayName: "Fix CI", status: "running" })],
			{
				ciCycle: {
					attempt: 0,
					maxAttempts: 3,
					monitorStartedAt: null,
					globalTimeoutMs: 0,
					lastCheckResults: [],
					failureLogs: [],
				},
			},
		);
		renderPipelineSteps(wf);

		const badge = document.querySelector(".review-badge");
		expect(badge).toBeNull();
	});

	// T013: Edge case — workflow with zero steps
	test("workflow with zero steps hides container", () => {
		const wf = makeWorkflowWithSteps([]);
		renderPipelineSteps(wf);

		const container = document.querySelector("#pipeline-steps");
		expect(container?.classList.contains("hidden")).toBe(true);
		expect(container?.children.length).toBe(0);
	});

	test("null workflow hides container", () => {
		renderPipelineSteps(null);

		const container = document.querySelector("#pipeline-steps");
		expect(container?.classList.contains("hidden")).toBe(true);
	});

	test("step label displays displayName", () => {
		const wf = makeWorkflowWithSteps([makeStep({ displayName: "Specifying", status: "running" })]);
		renderPipelineSteps(wf);

		const label = document.querySelector(".step-label");
		expect(label?.textContent).toBe("Specifying");
	});

	test("selectedIndex adds step-selected class", () => {
		const wf = makeWorkflowWithSteps([
			makeStep({ status: "completed" }),
			makeStep({ status: "running" }),
		]);
		renderPipelineSteps(wf, 0);

		const steps = document.querySelectorAll(".pipeline-step");
		expect(steps[0].classList.contains("step-selected")).toBe(true);
		expect(steps[1].classList.contains("step-selected")).toBe(false);
	});

	test("non-pending steps are clickable when onStepClick provided", () => {
		const clicked: number[] = [];
		const wf = makeWorkflowWithSteps([
			makeStep({ status: "completed" }),
			makeStep({ status: "pending" }),
		]);
		renderPipelineSteps(wf, null, (i) => clicked.push(i));

		const steps = document.querySelectorAll(".pipeline-step");
		(steps[0] as HTMLElement).click();
		(steps[1] as HTMLElement).click(); // pending — should not fire

		expect(clicked).toEqual([0]);
	});
});
