import type { Locator, Page } from "@playwright/test";

export class FeedbackPanelPage {
	constructor(public readonly page: Page) {}

	panel(): Locator {
		return this.page.locator("#feedback-panel");
	}

	historyList(): Locator {
		return this.page.locator("#feedback-history");
	}

	historyEntries(): Locator {
		return this.historyList().locator(".feedback-entry");
	}

	emptyHistoryMessage(): Locator {
		return this.historyList().locator(".feedback-history-empty");
	}

	input(): Locator {
		return this.page.locator("#feedback-input");
	}

	submitButton(): Locator {
		return this.page.locator("#btn-submit-feedback");
	}
}
