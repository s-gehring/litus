import type { Locator, Page } from "@playwright/test";

/**
 * Locator for the dedicated "not found" empty-state rendered by the router
 * when a deep link targets an unknown workflow or epic id. Distinct from the
 * welcome area so the deep-link-to-missing-resource case is a real assertion,
 * not a blank page.
 */
export class NotFoundPage {
	constructor(public readonly page: Page) {}

	root(): Locator {
		return this.page.locator('[data-testid="not-found"]');
	}

	message(): Locator {
		return this.root().locator(".not-found-message");
	}
}
