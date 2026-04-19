import type { Locator, Page } from "@playwright/test";

export class AlertsPage {
	constructor(public readonly page: Page) {}

	private bellButton(): Locator {
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

	async currentBellCount(): Promise<number> {
		const badge = this.bellCount();
		if ((await badge.count()) === 0) return 0;
		const isHidden = await badge.evaluate((el) => el.classList.contains("hidden"));
		if (isHidden) return 0;
		const raw = (await badge.textContent())?.trim() ?? "0";
		const n = Number.parseInt(raw, 10);
		return Number.isFinite(n) ? n : 0;
	}

	private toastContainer(): Locator {
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
		// Assert the panel actually became visible so future callers that forget
		// to open it get a helpful failure instead of silently reading 0 rows
		// from `listRows()`. The `waitFor` short timeout keeps happy-path runs
		// fast while still exercising the assertion.
		await this.listPanel().waitFor({ state: "visible", timeout: 5_000 });
	}
}
