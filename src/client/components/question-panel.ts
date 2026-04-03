import type { Question } from "../../types";

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

export function showQuestion(question: Question): void {
	const panel = $("#question-panel");
	const content = $("#question-content");
	const confidence = $("#question-confidence");
	const answerInput = $("#answer-input") as HTMLTextAreaElement;
	const skipBtn = $("#btn-skip-question");

	content.textContent = question.content;
	confidence.textContent = "";

	skipBtn.classList.remove("hidden");
	skipBtn.textContent = "Skip";

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
