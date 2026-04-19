import { expect } from "@playwright/test";
import { QuestionPromptPage } from "../pages/question-prompt";
import type { WorkflowCardPage } from "../pages/workflow-card";

export interface AnswerOptions {
	/** Substring expected to appear in the question text. Stronger than
	 * "non-empty" — catches scenario bugs where a question is lost or
	 * replaced (FR-017). */
	expectQuestionContains?: string;
}

export async function answerClarifyingQuestion(
	card: WorkflowCardPage,
	answer: string,
	options: AnswerOptions = {},
): Promise<void> {
	const prompt = new QuestionPromptPage(card.page);
	await expect(prompt.panel()).toBeVisible({ timeout: 60_000 });
	await expect(prompt.questionContent()).not.toBeEmpty();
	if (options.expectQuestionContains) {
		await expect(prompt.questionContent()).toContainText(options.expectQuestionContains);
	}
	await prompt.answerInput().fill(answer);
	await prompt.submitButton().click();
	await expect(prompt.panel()).toBeHidden({ timeout: 30_000 });
}
