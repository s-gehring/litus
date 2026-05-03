import { beforeEach, describe, expect, test } from "bun:test";
import { renderAskAnswerPanel } from "../../src/client/components/ask-answer-panel";
import { hideDetailLayout } from "../../src/client/components/detail-layout";
import { showEpicFeedbackPanel } from "../../src/client/components/epic-feedback-panel";
import { makeWorkflowState } from "../helpers";

function mountHostMarkup(): void {
	document.body.innerHTML = `
		<div id="card-strip"></div>
		<div id="welcome-area"></div>
		<div id="detail-area">
			<div id="output-area" class="epic-tree-fullsize"></div>
			<div id="question-panel" class="question-panel hidden"></div>
			<div id="feedback-panel" class="question-panel feedback-panel hidden">
				<textarea id="feedback-input"></textarea>
				<button id="btn-submit-feedback"></button>
				<button id="btn-cancel-feedback"></button>
			</div>
			<div id="epic-feedback-panel" class="question-panel feedback-panel hidden">
				<textarea id="epic-feedback-input"></textarea>
				<div id="epic-feedback-error" class="epic-feedback-error hidden"></div>
				<button id="btn-submit-epic-feedback"></button>
				<button id="btn-cancel-epic-feedback"></button>
			</div>
		</div>
	`;
}

describe("hideDetailLayout", () => {
	beforeEach(() => {
		mountHostMarkup();
	});

	// Regression for fix/018: opening the epic feedback form on /epic/:id and
	// then navigating to /workflow/:id used to leave the textarea + submit
	// buttons visible on the spec view, where they appeared (incorrectly) to
	// take feedback for the spec. The detail tear-down now hides both the
	// spec and epic feedback panels symmetrically.
	test("hides the epic feedback panel along with the spec feedback panel", () => {
		showEpicFeedbackPanel({ epicId: "e1", onSubmit: () => {}, onCancel: () => {} });
		const panel = document.getElementById("epic-feedback-panel");
		expect(panel?.classList.contains("hidden")).toBe(false);

		hideDetailLayout();

		expect(panel?.classList.contains("hidden")).toBe(true);
		expect(panel?.dataset.epicId).toBeUndefined();
	});

	// Regression for fix/030: an ask-question workflow showing its synthesized
	// answer left the #ask-answer-panel mounted inside #detail-area when the
	// user navigated away (e.g. to an epic, which re-shows #detail-area without
	// re-rendering an ask-answer surface). Tearing down the detail layout must
	// drop the panel so it does not bleed into the next view.
	test("removes the ask-answer panel along with the other detail panels", () => {
		const detailArea = document.getElementById("detail-area") as HTMLElement;
		const wf = makeWorkflowState({
			workflowKind: "ask-question",
			synthesizedAnswer: {
				markdown: "Here is the answer.",
				updatedAt: new Date().toISOString(),
				sourceFileName: "answer.md",
			},
		});
		renderAskAnswerPanel(detailArea, wf, {});
		expect(document.getElementById("ask-answer-panel")).not.toBeNull();

		hideDetailLayout();

		expect(document.getElementById("ask-answer-panel")).toBeNull();
		const outputArea = document.getElementById("output-area");
		expect(outputArea?.classList.contains("hidden")).toBe(false);
	});
});
