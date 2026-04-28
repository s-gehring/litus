import { beforeEach, describe, expect, test } from "bun:test";
import { hideDetailLayout } from "../../src/client/components/detail-layout";
import { showEpicFeedbackPanel } from "../../src/client/components/epic-feedback-panel";

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
});
