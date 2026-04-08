import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getAnswer, hideQuestion, showQuestion } from "../../src/client/components/question-panel";
import type { Question } from "../../src/types";

const PANEL_HTML = `
<div id="question-panel" class="question-panel hidden">
  <div class="question-header">
    <span class="question-label">Agent Question</span>
    <span id="question-confidence" class="confidence-badge"></span>
  </div>
  <p id="question-content" class="question-content"></p>
  <div class="question-actions">
    <textarea id="answer-input" class="answer-input" placeholder="Type your answer..." rows="2"></textarea>
    <div class="question-buttons">
      <button id="btn-submit-answer" class="btn btn-primary">Submit</button>
      <button id="btn-skip-question" class="btn btn-secondary hidden">Skip</button>
    </div>
  </div>
</div>
`;

function makeQuestion(overrides?: Partial<Question>): Question {
	return {
		id: "q-1",
		content: "What repository should I use?",
		detectedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("question-panel", () => {
	beforeEach(() => {
		document.body.innerHTML = PANEL_HTML;
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	// T020: showQuestion makes panel visible with sanitized markdown content
	test("showQuestion makes panel visible with rendered content", () => {
		const q = makeQuestion({ content: "Which **repo**?" });
		showQuestion(q);

		const panel = document.querySelector("#question-panel");
		expect(panel?.classList.contains("hidden")).toBe(false);

		const content = document.querySelector("#question-content");
		// renderMarkdown converts **repo** to <strong>repo</strong> via marked + DOMPurify
		expect(content?.innerHTML).toContain("<strong>repo</strong>");
	});

	test("showQuestion clears previous answer input", () => {
		const textarea = document.querySelector("#answer-input") as HTMLTextAreaElement;
		textarea.value = "old answer";

		showQuestion(makeQuestion());
		expect(textarea.value).toBe("");
	});

	test("showQuestion shows skip button", () => {
		showQuestion(makeQuestion());

		const skipBtn = document.querySelector("#btn-skip-question");
		expect(skipBtn?.classList.contains("hidden")).toBe(false);
		expect(skipBtn?.textContent).toBe("Skip");
	});

	test("showQuestion clears confidence text", () => {
		const confidence = document.querySelector("#question-confidence") as HTMLElement;
		confidence.textContent = "high";

		showQuestion(makeQuestion());
		expect(confidence.textContent).toBe("");
	});

	// T021: hideQuestion hides the panel
	test("hideQuestion hides the panel", () => {
		showQuestion(makeQuestion());
		expect(document.querySelector("#question-panel")?.classList.contains("hidden")).toBe(false);

		hideQuestion();
		expect(document.querySelector("#question-panel")?.classList.contains("hidden")).toBe(true);
	});

	// T022: getAnswer returns trimmed textarea value
	test("getAnswer returns trimmed textarea value", () => {
		const textarea = document.querySelector("#answer-input") as HTMLTextAreaElement;
		textarea.value = "  my answer  ";

		expect(getAnswer()).toBe("my answer");
	});

	test("getAnswer returns empty string for empty textarea", () => {
		expect(getAnswer()).toBe("");
	});

	// T023: XSS payload — verify sanitization strips script tags
	test("question content with script tags is sanitized", () => {
		const q = makeQuestion({ content: '<script>alert("xss")</script>Legit text' });
		showQuestion(q);

		const content = document.querySelector("#question-content");
		// DOMPurify strips script tags
		expect(content?.innerHTML).not.toContain("<script>");
		expect(content?.innerHTML).toContain("Legit text");
	});

	test("question content with onerror handler is sanitized", () => {
		const q = makeQuestion({ content: '<img src=x onerror="alert(1)">Hello' });
		showQuestion(q);

		const content = document.querySelector("#question-content");
		expect(content?.innerHTML).not.toContain("onerror");
		expect(content?.innerHTML).toContain("Hello");
	});
});
