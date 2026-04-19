import type { Locator, Page } from "@playwright/test";

export class WelcomePage {
	constructor(public readonly page: Page) {}

	root(): Locator {
		return this.page.locator("#welcome-area");
	}

	text(): Locator {
		return this.root().locator(".welcome-text");
	}
}
