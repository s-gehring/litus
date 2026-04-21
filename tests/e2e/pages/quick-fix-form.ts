import type { Locator, Page } from "@playwright/test";

export class QuickFixFormPage {
	constructor(public readonly page: Page) {}

	modal(): Locator {
		return this.page
			.locator(".modal-panel")
			.filter({ has: this.page.locator(".modal-title", { hasText: "Quick Fix" }) });
	}

	repoInput(): Locator {
		return this.modal().locator(".folder-picker input");
	}

	descriptionInput(): Locator {
		return this.modal().locator('textarea[placeholder*="Describe"]');
	}

	submitButton(): Locator {
		return this.modal().locator(".btn.btn-primary");
	}

	errorMessage(): Locator {
		return this.modal().locator(".modal-error");
	}
}
