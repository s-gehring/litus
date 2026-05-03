import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "../happydom";
import {
	hideAskAnswerPanel,
	renderAskAnswerPanel,
} from "../../src/client/components/ask-answer-panel";
import { STEP } from "../../src/pipeline-steps";
import { makeWorkflowState } from "../helpers";

const BASE_DOM = `
	<div id="detail-area">
		<div id="output-area"><div id="output-log"></div></div>
	</div>
`;

describe("ask-answer-panel", () => {
	let parent: HTMLElement;

	beforeEach(() => {
		document.body.innerHTML = BASE_DOM;
		parent = document.getElementById("detail-area") as HTMLElement;
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	test("does not render an inline Finalize or feedback form (controls live in the action bar)", () => {
		const wf = makeWorkflowState({
			workflowKind: "ask-question",
			status: "waiting_for_input",
			steps: [
				{
					name: STEP.ANSWER,
					displayName: "Answer",
					status: "running",
					output: "",
					outputLog: [],
					error: null,
					startedAt: null,
					completedAt: null,
					history: [],
					outcome: null,
				},
			],
			currentStepIndex: 0,
			synthesizedAnswer: {
				markdown: "# The Answer\n\nHello.",
				updatedAt: new Date().toISOString(),
				sourceFileName: "answer.md",
			},
		});

		renderAskAnswerPanel(parent, wf, {});

		const panel = parent.querySelector("#ask-answer-panel");
		expect(panel).not.toBeNull();
		expect(panel?.querySelector(".ask-answer-feedback")).toBeNull();
		expect(panel?.querySelector(".ask-answer-finalize")).toBeNull();
		expect(panel?.querySelector("textarea")).toBeNull();
		expect(panel?.querySelector("button")).toBeNull();
	});

	test("hides the output-area while the synthesized answer is on screen", () => {
		const wf = makeWorkflowState({
			workflowKind: "ask-question",
			status: "waiting_for_input",
			steps: [
				{
					name: STEP.ANSWER,
					displayName: "Answer",
					status: "running",
					output: "",
					outputLog: [],
					error: null,
					startedAt: null,
					completedAt: null,
					history: [],
					outcome: null,
				},
			],
			currentStepIndex: 0,
			synthesizedAnswer: {
				markdown: "Done.",
				updatedAt: new Date().toISOString(),
				sourceFileName: "answer.md",
			},
		});

		renderAskAnswerPanel(parent, wf, {});

		const outputArea = document.getElementById("output-area");
		expect(outputArea?.classList.contains("hidden")).toBe(true);
	});

	test("leaves the output-area visible when no answer is being shown", () => {
		const wf = makeWorkflowState({
			workflowKind: "ask-question",
			status: "running",
			steps: [
				{
					name: STEP.RESEARCH_ASPECT,
					displayName: "Researching Aspect",
					status: "running",
					output: "",
					outputLog: [],
					error: null,
					startedAt: null,
					completedAt: null,
					history: [],
					outcome: null,
				},
			],
			currentStepIndex: 0,
			synthesizedAnswer: null,
		});

		renderAskAnswerPanel(parent, wf, {});

		const outputArea = document.getElementById("output-area");
		expect(outputArea?.classList.contains("hidden")).toBe(false);
	});

	test("hideAskAnswerPanel restores output-area visibility", () => {
		const outputArea = document.getElementById("output-area") as HTMLElement;
		outputArea.classList.add("hidden");

		hideAskAnswerPanel(parent);

		expect(outputArea.classList.contains("hidden")).toBe(false);
	});

	test("hides the panel itself when there is nothing to render", () => {
		const wf = makeWorkflowState({
			workflowKind: "ask-question",
			status: "running",
			steps: [
				{
					name: STEP.DECOMPOSE,
					displayName: "Decomposing Question",
					status: "running",
					output: "",
					outputLog: [],
					error: null,
					startedAt: null,
					completedAt: null,
					history: [],
					outcome: null,
				},
			],
			currentStepIndex: 0,
			synthesizedAnswer: null,
			aspects: null,
		});

		renderAskAnswerPanel(parent, wf, {});

		const panel = parent.querySelector<HTMLElement>("#ask-answer-panel");
		expect(panel?.classList.contains("hidden")).toBe(true);
	});
});
