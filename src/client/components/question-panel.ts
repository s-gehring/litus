import type { Question } from "../../types";
import { $ } from "../dom";
import { renderMarkdown } from "../render-markdown";

export function showQuestion(question: Question): void {
	const panel = $("#question-panel");
	const content = $("#question-content");
	const confidence = $("#question-confidence");
	const answerInput = $("#answer-input") as HTMLTextAreaElement;
	const skipBtn = $("#btn-skip-question");

	content.innerHTML = renderMarkdown(question.content);
	confidence.textContent = "";

	skipBtn.classList.remove("hidden");
	skipBtn.textContent = "Skip";

	// Re-enable buttons (may have been disabled after previous submission)
	const submitBtn = $("#btn-submit-answer") as HTMLButtonElement;
	submitBtn.disabled = false;
	(skipBtn as HTMLButtonElement).disabled = false;

	answerInput.value = "";
	panel.classList.remove("hidden");
	answerInput.focus();
}

export function hideQuestion(): void {
	const panel = $("#question-panel");
	panel.classList.add("hidden");
}

export function getAnswer(): string {
	const answerInput = $("#answer-input") as HTMLTextAreaElement;
	return answerInput.value.trim();
}
