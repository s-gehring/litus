import type { Locator, Page } from "@playwright/test";

export class ArtifactViewerPage {
	constructor(public readonly page: Page) {}

	/**
	 * The per-step `📄` affordance button rendered inside each pipeline step
	 * that has one or more artifacts. Scoped by `.pipeline-step` + step label
	 * so tests can target a specific step.
	 */
	affordanceForStep(displayName: string): Locator {
		return this.page
			.locator(".pipeline-step")
			.filter({ has: this.page.locator(".step-label", { hasText: displayName }) })
			.locator(".artifact-affordance");
	}

	/** Any artifact affordance button on the page (first one with descriptors). */
	anyAffordance(): Locator {
		return this.page.locator(".artifact-affordance").first();
	}

	private dropdown(): Locator {
		return this.page.locator(".artifact-dropdown");
	}

	dropdownItems(): Locator {
		return this.dropdown().locator(".artifact-dropdown-item");
	}

	dropdownItemByLabel(label: string): Locator {
		return this.dropdownItems().filter({ hasText: label });
	}

	modal(): Locator {
		return this.page.locator(".artifact-modal");
	}

	modalBody(): Locator {
		return this.modal().locator(".artifact-modal-body");
	}

	downloadLink(): Locator {
		return this.modal().locator(".artifact-modal-download");
	}

	closeButton(): Locator {
		return this.modal().locator(".artifact-modal-close");
	}
}
