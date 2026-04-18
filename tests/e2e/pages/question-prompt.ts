import type { Locator, Page } from "@playwright/test";

export class QuestionPromptPage {
	constructor(public readonly page: Page) {}

	panel(): Locator {
		return this.page.locator("#question-panel");
	}

	questionContent(): Locator {
		return this.page.locator("#question-content");
	}

	answerInput(): Locator {
		return this.page.locator("#answer-input");
	}

	submitButton(): Locator {
		return this.page.locator("#btn-submit-answer");
	}
}
