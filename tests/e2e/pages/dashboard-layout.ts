import type { Locator, Page } from "@playwright/test";

export class DashboardLayoutPage {
	constructor(public readonly page: Page) {}

	detailArea(): Locator {
		return this.page.locator("#detail-area");
	}

	userInput(): Locator {
		return this.page.locator("#user-input");
	}

	cardStrip(): Locator {
		return this.page.locator("#card-strip");
	}

	pipelineSteps(): Locator {
		return this.page.locator("#pipeline-steps");
	}

	pipelineStepRows(): Locator {
		return this.pipelineSteps().locator(".pipeline-step");
	}
}
