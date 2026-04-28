import { beforeEach, describe, expect, test } from "bun:test";
import {
	hideEpicFeedbackPanel,
	hideEpicFeedbackPanelUnlessFor,
	isEpicFeedbackPanelVisible,
	showEpicFeedbackError,
	showEpicFeedbackPanel,
} from "../../src/client/components/epic-feedback-panel";
import { EPIC_FEEDBACK_MAX_LENGTH } from "../../src/types";

function mountHostMarkup(): void {
	document.body.innerHTML = `
		<div id="epic-feedback-panel" class="question-panel feedback-panel hidden">
			<div class="question-actions">
				<textarea id="epic-feedback-input" class="answer-input" rows="3"></textarea>
				<div id="epic-feedback-error" class="epic-feedback-error hidden"></div>
				<div class="question-buttons">
					<button id="btn-submit-epic-feedback" class="btn btn-primary">Submit</button>
					<button id="btn-cancel-epic-feedback" class="btn btn-secondary">Cancel</button>
				</div>
			</div>
		</div>
	`;
}

describe("epic-feedback-panel", () => {
	beforeEach(() => {
		mountHostMarkup();
	});

	test("show binds dataset.epicId, removes hidden, focuses textarea", () => {
		showEpicFeedbackPanel({ epicId: "e1", onSubmit: () => {}, onCancel: () => {} });
		const panel = document.getElementById("epic-feedback-panel");
		expect(panel?.classList.contains("hidden")).toBe(false);
		expect(panel?.dataset.epicId).toBe("e1");
		expect(isEpicFeedbackPanelVisible()).toBe(true);
		expect(panel?.dataset.epicId).toBe("e1");
	});

	test("submit button disabled on empty input", () => {
		showEpicFeedbackPanel({ epicId: "e1", onSubmit: () => {}, onCancel: () => {} });
		const btn = document.getElementById("btn-submit-epic-feedback") as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
	});

	test("submit button disabled on whitespace-only input", () => {
		showEpicFeedbackPanel({ epicId: "e1", onSubmit: () => {}, onCancel: () => {} });
		const input = document.getElementById("epic-feedback-input") as HTMLTextAreaElement;
		input.value = "   \n\t";
		input.dispatchEvent(new Event("input"));
		const btn = document.getElementById("btn-submit-epic-feedback") as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
	});

	test("submit button disabled on trimmed length > MAX_LENGTH", () => {
		showEpicFeedbackPanel({ epicId: "e1", onSubmit: () => {}, onCancel: () => {} });
		const input = document.getElementById("epic-feedback-input") as HTMLTextAreaElement;
		input.value = "x".repeat(EPIC_FEEDBACK_MAX_LENGTH + 1);
		input.dispatchEvent(new Event("input"));
		const btn = document.getElementById("btn-submit-epic-feedback") as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
	});

	test("submit delivers trimmed text to callback", () => {
		const submissions: string[] = [];
		showEpicFeedbackPanel({
			epicId: "e1",
			onSubmit: (t) => submissions.push(t),
			onCancel: () => {},
		});
		const input = document.getElementById("epic-feedback-input") as HTMLTextAreaElement;
		input.value = "  please refine  ";
		input.dispatchEvent(new Event("input"));
		const btn = document.getElementById("btn-submit-epic-feedback") as HTMLButtonElement;
		btn.click();
		expect(submissions).toEqual(["please refine"]);
	});

	test("cancel invokes onCancel callback", () => {
		let cancelled = false;
		showEpicFeedbackPanel({
			epicId: "e1",
			onSubmit: () => {},
			onCancel: () => {
				cancelled = true;
			},
		});
		const btn = document.getElementById("btn-cancel-epic-feedback") as HTMLButtonElement;
		btn.click();
		expect(cancelled).toBe(true);
	});

	test("hide adds .hidden, clears dataset, clears error", () => {
		showEpicFeedbackPanel({ epicId: "e1", onSubmit: () => {}, onCancel: () => {} });
		showEpicFeedbackError("oops");
		hideEpicFeedbackPanel();
		const panel = document.getElementById("epic-feedback-panel");
		const errorEl = document.getElementById("epic-feedback-error");
		expect(panel?.classList.contains("hidden")).toBe(true);
		expect(panel?.dataset.epicId).toBeUndefined();
		expect(errorEl?.textContent).toBe("");
		expect(errorEl?.classList.contains("hidden")).toBe(true);
		expect(isEpicFeedbackPanelVisible()).toBe(false);
	});

	test("hideUnlessFor preserves panel for the active epicId, hides for other", () => {
		showEpicFeedbackPanel({ epicId: "e1", onSubmit: () => {}, onCancel: () => {} });
		hideEpicFeedbackPanelUnlessFor("e1");
		expect(isEpicFeedbackPanelVisible()).toBe(true);

		hideEpicFeedbackPanelUnlessFor("e2");
		expect(isEpicFeedbackPanelVisible()).toBe(false);
	});

	test("showEpicFeedbackError displays inline error and preserves textarea value", () => {
		showEpicFeedbackPanel({ epicId: "e1", onSubmit: () => {}, onCancel: () => {} });
		const input = document.getElementById("epic-feedback-input") as HTMLTextAreaElement;
		input.value = "hello";
		input.dispatchEvent(new Event("input"));
		showEpicFeedbackError("A child spec has already started.");
		const errorEl = document.getElementById("epic-feedback-error");
		expect(errorEl?.textContent).toBe("A child spec has already started.");
		expect(errorEl?.classList.contains("hidden")).toBe(false);
		expect(input.value).toBe("hello");
	});

	test("show with initialText prefills textarea (draft retention)", () => {
		showEpicFeedbackPanel({
			epicId: "e1",
			initialText: "draft text",
			onSubmit: () => {},
			onCancel: () => {},
		});
		const input = document.getElementById("epic-feedback-input") as HTMLTextAreaElement;
		expect(input.value).toBe("draft text");
	});
});
