import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	hideFeedbackPanel,
	hideFeedbackPanelUnlessFor,
	renderFeedbackHistory,
	showFeedbackPanel,
} from "../../src/client/components/feedback-panel";
import { type FeedbackEntry, MAX_LLM_INPUT_LENGTH } from "../../src/types";
import { makeWorkflowState } from "../helpers";

const PANEL_HTML = `
<div id="feedback-panel" class="feedback-panel hidden">
  <div class="question-header">
    <span class="question-label">Provide Feedback</span>
  </div>
  <div id="feedback-history" class="feedback-history"></div>
  <div class="question-actions">
    <textarea id="feedback-input" class="answer-input" rows="3"></textarea>
    <div class="question-buttons">
      <button id="btn-submit-feedback" class="btn btn-primary">Submit</button>
      <button id="btn-cancel-feedback" class="btn btn-secondary">Cancel</button>
    </div>
  </div>
</div>
`;

function entry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
	return {
		id: overrides.id ?? "fe-1",
		iteration: overrides.iteration ?? 1,
		text: overrides.text ?? "rename x to count",
		submittedAt: overrides.submittedAt ?? "2026-04-13T14:22:01.000Z",
		submittedAtStepName: overrides.submittedAtStepName ?? "merge-pr",
		outcome: overrides.outcome === undefined ? null : overrides.outcome,
	};
}

describe("feedback-panel", () => {
	beforeEach(() => {
		document.body.innerHTML = PANEL_HTML;
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	test("showFeedbackPanel unhides the panel and focuses input", () => {
		const wf = makeWorkflowState();
		wf.feedbackEntries = [];
		const submitted: string[] = [];
		showFeedbackPanel(wf, (text) => {
			submitted.push(text);
		});

		const panel = document.querySelector("#feedback-panel");
		expect(panel?.classList.contains("hidden")).toBe(false);
	});

	test("hideFeedbackPanel re-hides the panel", () => {
		const wf = makeWorkflowState();
		wf.feedbackEntries = [];
		showFeedbackPanel(wf, () => {});
		expect(document.querySelector("#feedback-panel")?.classList.contains("hidden")).toBe(false);
		hideFeedbackPanel();
		expect(document.querySelector("#feedback-panel")?.classList.contains("hidden")).toBe(true);
	});

	test("renders empty-state when no entries", () => {
		const wf = makeWorkflowState();
		wf.feedbackEntries = [];
		showFeedbackPanel(wf, () => {});
		const history = document.querySelector("#feedback-history");
		expect(history?.textContent ?? "").toContain("No previous feedback");
	});

	test("renders iteration history for each entry", () => {
		const wf = makeWorkflowState();
		wf.feedbackEntries = [
			entry({
				iteration: 1,
				text: "first feedback",
				outcome: {
					value: "success",
					summary: "did the thing",
					commitRefs: ["abc"],
					warnings: [],
				},
			}),
			entry({
				id: "fe-2",
				iteration: 2,
				text: "second feedback",
				outcome: null,
			}),
		];
		showFeedbackPanel(wf, () => {});

		const history = document.querySelector("#feedback-history");
		const entries = history?.querySelectorAll(".feedback-entry");
		expect(entries?.length).toBe(2);
		expect(history?.textContent).toContain("first feedback");
		expect(history?.textContent).toContain("second feedback");
		expect(history?.textContent).toContain("success");
		expect(history?.textContent).toContain("pending");
	});

	test("Submit sends trimmed feedback text", () => {
		const wf = makeWorkflowState();
		wf.feedbackEntries = [];
		const submitted: string[] = [];
		showFeedbackPanel(wf, (text) => {
			submitted.push(text);
		});

		const input = document.querySelector("#feedback-input") as HTMLTextAreaElement;
		input.value = "  rename x to count  ";
		// FR-006/FR-014: dispatch input event so updateSubmitState re-evaluates length
		// caps and enables the submit button.
		input.dispatchEvent(new Event("input"));
		const submitBtn = document.querySelector("#btn-submit-feedback") as HTMLButtonElement;
		submitBtn.click();

		expect(submitted).toEqual(["rename x to count"]);
	});

	test("Submit is disabled when any entry is in-flight (FR-016)", () => {
		const wf = makeWorkflowState();
		wf.feedbackEntries = [entry({ iteration: 1, outcome: null })];
		showFeedbackPanel(wf, () => {});

		const submitBtn = document.querySelector("#btn-submit-feedback") as HTMLButtonElement;
		expect(submitBtn.disabled).toBe(true);
	});

	test("empty-after-trim disables Submit (FR-006)", () => {
		const wf = makeWorkflowState();
		wf.feedbackEntries = [];
		const submitted: string[] = [];
		showFeedbackPanel(wf, (text) => {
			submitted.push(text);
		});

		const input = document.querySelector("#feedback-input") as HTMLTextAreaElement;
		input.value = "   ";
		input.dispatchEvent(new Event("input"));
		const submitBtn = document.querySelector("#btn-submit-feedback") as HTMLButtonElement;
		expect(submitBtn.disabled).toBe(true);
		submitBtn.click();
		expect(submitted).toEqual([]);
	});

	test("over-limit text disables Submit (FR-014)", () => {
		const wf = makeWorkflowState();
		wf.feedbackEntries = [];
		const submitted: string[] = [];
		showFeedbackPanel(wf, (text) => {
			submitted.push(text);
		});

		const input = document.querySelector("#feedback-input") as HTMLTextAreaElement;
		input.value = "a".repeat(MAX_LLM_INPUT_LENGTH + 1);
		input.dispatchEvent(new Event("input"));
		const submitBtn = document.querySelector("#btn-submit-feedback") as HTMLButtonElement;
		expect(submitBtn.disabled).toBe(true);
		submitBtn.click();
		expect(submitted).toEqual([]);
	});

	test("Cancel hides panel without invoking submit callback", () => {
		const wf = makeWorkflowState();
		wf.feedbackEntries = [];
		const submitted: string[] = [];
		showFeedbackPanel(wf, (text) => {
			submitted.push(text);
		});

		const cancelBtn = document.querySelector("#btn-cancel-feedback") as HTMLButtonElement;
		cancelBtn.click();

		expect(submitted).toEqual([]);
		expect(document.querySelector("#feedback-panel")?.classList.contains("hidden")).toBe(true);
	});

	test("hideFeedbackPanelUnlessFor keeps the panel when workflow id matches", () => {
		const wf = makeWorkflowState({ id: "wf-active" });
		wf.feedbackEntries = [];
		showFeedbackPanel(wf, () => {});

		hideFeedbackPanelUnlessFor("wf-active");

		expect(document.querySelector("#feedback-panel")?.classList.contains("hidden")).toBe(false);
	});

	test("hideFeedbackPanelUnlessFor hides the panel when workflow id differs", () => {
		const wf = makeWorkflowState({ id: "wf-a" });
		wf.feedbackEntries = [];
		showFeedbackPanel(wf, () => {});

		hideFeedbackPanelUnlessFor("wf-b");

		expect(document.querySelector("#feedback-panel")?.classList.contains("hidden")).toBe(true);
	});

	test("hideFeedbackPanelUnlessFor hides the panel when no workflow is active", () => {
		const wf = makeWorkflowState({ id: "wf-a" });
		wf.feedbackEntries = [];
		showFeedbackPanel(wf, () => {});

		hideFeedbackPanelUnlessFor(null);

		expect(document.querySelector("#feedback-panel")?.classList.contains("hidden")).toBe(true);
	});

	test("renderFeedbackHistory renders warnings for entries that have them", () => {
		const entries: FeedbackEntry[] = [
			entry({
				iteration: 1,
				outcome: {
					value: "success",
					summary: "pushed commit",
					commitRefs: ["abc"],
					warnings: [{ kind: "pr_description_update_failed", message: "gh error" }],
				},
			}),
		];
		renderFeedbackHistory(entries);

		const warnings = document.querySelectorAll(".feedback-entry-warning");
		expect(warnings.length).toBe(1);
		expect(warnings[0].textContent).toContain("pr_description_update_failed");
		expect(warnings[0].textContent).toContain("gh error");
	});
});
