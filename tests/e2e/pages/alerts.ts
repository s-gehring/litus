import type { Locator, Page } from "@playwright/test";

export class AlertsPage {
	constructor(public readonly page: Page) {}

	bellButton(): Locator {
		return this.page.locator("#btn-alert-bell");
	}

	/**
	 * The `.bell-count` element exists unconditionally; its `hidden` class is
	 * toggled based on whether alerts are present. Callers assert visibility
	 * via `toBeVisible()`/`toBeHidden()` rather than presence.
	 */
	bellCount(): Locator {
		return this.bellButton().locator(".bell-count");
	}

	toastContainer(): Locator {
		return this.page.locator("#alert-toast-container");
	}

	toasts(): Locator {
		return this.toastContainer().locator(".alert-toast:not(.alert-toast-overflow)");
	}

	listPanel(): Locator {
		return this.page.locator("#alert-list-panel");
	}

	listRows(): Locator {
		return this.listPanel().locator(".alert-list-row");
	}

	dismissButton(row: Locator): Locator {
		return row.locator(".alert-list-dismiss");
	}

	async openList(): Promise<void> {
		await this.bellButton().click();
	}
}
