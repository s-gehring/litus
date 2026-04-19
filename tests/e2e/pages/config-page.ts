import type { Locator, Page } from "@playwright/test";

export class ConfigPageObject {
	constructor(public readonly page: Page) {}

	root(): Locator {
		return this.page.locator(".config-page");
	}
}
