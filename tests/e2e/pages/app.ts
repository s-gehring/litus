import type { Locator, Page } from "@playwright/test";

export class AppPage {
	constructor(public readonly page: Page) {}

	async goto(baseUrl: string) {
		await this.page.goto(baseUrl);
	}

	newSpecButton(): Locator {
		return this.page.locator("#btn-new-spec");
	}

	quickFixButton(): Locator {
		return this.page.locator("#btn-quick-fix");
	}

	newEpicButton(): Locator {
		return this.page.locator("#btn-new-epic");
	}

	cardStrip(): Locator {
		return this.page.locator("#card-strip");
	}

	workflowCards(): Locator {
		return this.page.locator(".workflow-card");
	}

	async waitConnected() {
		await this.page.locator("#connection-status.connected").waitFor({ state: "attached" });
	}
}
