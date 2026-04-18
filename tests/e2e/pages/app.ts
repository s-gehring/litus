import type { Locator, Page } from "@playwright/test";

export class AppPage {
	constructor(public readonly page: Page) {}

	async goto(baseUrl: string) {
		await this.page.goto(baseUrl);
	}

	connectionStatus(): Locator {
		return this.page.locator("#connection-status");
	}

	newSpecButton(): Locator {
		return this.page.locator("#btn-new-spec");
	}

	cardStrip(): Locator {
		return this.page.locator("#card-strip");
	}

	workflowCards(): Locator {
		return this.page.locator(".workflow-card");
	}

	workflowCardById(workflowId: string): Locator {
		return this.page.locator(`.workflow-card[data-workflow-id="${workflowId}"]`);
	}

	async waitConnected() {
		await this.page.locator("#connection-status.connected").waitFor({ state: "attached" });
	}
}
