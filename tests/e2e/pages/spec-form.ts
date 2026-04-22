import type { Locator, Page } from "@playwright/test";

export class SpecFormPage {
	constructor(public readonly page: Page) {}

	modal(): Locator {
		return this.page
			.locator(".modal-panel")
			.filter({ has: this.page.locator(".modal-title", { hasText: "New Specification" }) });
	}

	repoInput(): Locator {
		return this.modal().locator(".folder-picker input");
	}

	specificationInput(): Locator {
		return this.modal().locator('textarea[placeholder*="Describe"]');
	}

	submitButton(): Locator {
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

	cloneStatus(): Locator {
		return this.modal().locator(".modal-clone-status");
	}
}
