import { beforeEach, describe, expect, test } from "bun:test";
import { createEpicFeedbackPanel } from "../../src/client/components/epic-feedback-panel";
import { EPIC_FEEDBACK_MAX_LENGTH } from "../../src/types";

describe("epic-feedback-panel", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	test("submit button disabled on empty input", () => {
		const submissions: string[] = [];
		const handle = createEpicFeedbackPanel({
			epicId: "e1",
			onSubmit: (t) => submissions.push(t),
		});
		document.body.appendChild(handle.element);
		const btn = handle.element.querySelector<HTMLButtonElement>("button");
		expect(btn?.disabled).toBe(true);
	});

	test("submit button disabled on whitespace-only input", () => {
		const handle = createEpicFeedbackPanel({ epicId: "e1", onSubmit: () => {} });
		document.body.appendChild(handle.element);
		const textarea = handle.element.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("textarea missing");
		textarea.value = "     \n\t";
		textarea.dispatchEvent(new Event("input"));
		const btn = handle.element.querySelector<HTMLButtonElement>("button");
		expect(btn?.disabled).toBe(true);
	});

	test("char counter updates on input", () => {
		const handle = createEpicFeedbackPanel({ epicId: "e1", onSubmit: () => {} });
		document.body.appendChild(handle.element);
		const textarea = handle.element.querySelector<HTMLTextAreaElement>("textarea");
		const counter = handle.element.querySelector(".epic-feedback-counter");
		if (!textarea || !counter) throw new Error("missing elements");
		textarea.value = "hello world";
		textarea.dispatchEvent(new Event("input"));
		expect(counter.textContent).toContain(`11 / ${EPIC_FEEDBACK_MAX_LENGTH}`);
	});

	test("submit button disabled on trimmed length > MAX_LENGTH", () => {
		const handle = createEpicFeedbackPanel({ epicId: "e1", onSubmit: () => {} });
		document.body.appendChild(handle.element);
		const textarea = handle.element.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("textarea missing");
		textarea.value = "x".repeat(EPIC_FEEDBACK_MAX_LENGTH + 1);
		textarea.dispatchEvent(new Event("input"));
		const btn = handle.element.querySelector<HTMLButtonElement>("button");
		expect(btn?.disabled).toBe(true);
		const counter = handle.element.querySelector(".epic-feedback-counter");
		expect(counter?.classList.contains("over-limit")).toBe(true);
	});

	test("submit delivers trimmed text to callback", () => {
		const submissions: string[] = [];
		const handle = createEpicFeedbackPanel({
			epicId: "e1",
			onSubmit: (t) => submissions.push(t),
		});
		document.body.appendChild(handle.element);
		const textarea = handle.element.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("textarea missing");
		textarea.value = "  please refine  ";
		textarea.dispatchEvent(new Event("input"));
		const btn = handle.element.querySelector<HTMLButtonElement>("button");
		btn?.click();
		expect(submissions).toEqual(["please refine"]);
	});

	test("showError displays inline error and preserves textarea value", () => {
		const handle = createEpicFeedbackPanel({ epicId: "e1", onSubmit: () => {} });
		document.body.appendChild(handle.element);
		const textarea = handle.element.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("textarea missing");
		textarea.value = "hello";
		textarea.dispatchEvent(new Event("input"));
		handle.showError("A child spec has already started.");
		const errorEl = handle.element.querySelector(".epic-feedback-error");
		expect(errorEl?.textContent).toBe("A child spec has already started.");
		expect(errorEl?.classList.contains("hidden")).toBe(false);
		expect(textarea.value).toBe("hello");
	});
});
