import type { Locator, Page } from "@playwright/test";

export class EpicFormPage {
	constructor(public readonly page: Page) {}

	modal(): Locator {
		return this.page
			.locator(".modal-panel")
			.filter({ has: this.page.locator(".modal-title", { hasText: "New Epic" }) });
	}

	repoInput(): Locator {
		return this.modal().locator(".folder-picker input");
	}

	descriptionInput(): Locator {
		return this.modal().locator('textarea[placeholder*="Describe"]');
	}

	createButton(): Locator {
		return this.modal().locator(".btn.btn-secondary");
	}

	createAndStartButton(): Locator {
		return this.modal().locator(".btn.btn-primary");
	}

	errorMessage(): Locator {
		return this.modal().locator(".modal-error");
	}

	fieldError(): Locator {
		return this.modal().locator(".modal-field-error");
	}

	fieldSuccess(): Locator {
		return this.modal().locator(".modal-field-success");
	}
}
