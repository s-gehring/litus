import type { Locator, Page } from "@playwright/test";

/**
 * Page object for the config page rendered by
 * `src/client/components/config-page.ts`. Selectors target the `data-cfg-path`
 * attribute on inputs/selects/textareas (plus the action buttons) — the same
 * attribute `updateConfigPage` uses to sync AppConfig values back to the DOM.
 */
export class ConfigPage {
	constructor(public readonly page: Page) {}

	async goto(baseUrl: string) {
		await this.page.goto(`${baseUrl}/config`);
	}

	root(): Locator {
		return this.page.locator(".config-page");
	}

	/** Click the tab whose label matches `id` (e.g. `"models"`, `"prompts"`). */
	async activateTab(id: "models" | "limits" | "timing" | "prompts" | "telegram"): Promise<void> {
		await this.page.locator(`.cfg-tab[data-tab="${id}"]`).click();
		await this.page.locator(`.cfg-tab[data-tab="${id}"].cfg-tab--active`).waitFor();
	}

	/** Text input for `models.<key>`. */
	modelInput(key: string): Locator {
		return this.page.locator(`input[data-cfg-path="models.${key}"]`);
	}

	/** Effort `<select>` for `efforts.<key>`. */
	effortSelect(key: string): Locator {
		return this.page.locator(`select[data-cfg-path="efforts.${key}"]`);
	}

	/** Prompt `<textarea>` for `prompts.<key>`. */
	promptTextarea(key: string): Locator {
		return this.page.locator(`textarea[data-cfg-path="prompts.${key}"]`);
	}

	resetAllButton(): Locator {
		return this.page.locator(".cfg-reset-all-btn");
	}

	purgeAllButton(): Locator {
		return this.page.locator(".cfg-purge-btn");
	}

	/** Error-class lines in the global `#output-log`. `appendOutput` uses the
	 * class `output-line error` for both the purge-error and the
	 * partial-warnings-before-abort lines — scoped here for
	 * purge-all-spec assertions. */
	outputLogErrorLines(): Locator {
		return this.page.locator("#output-log .output-line.error");
	}
}
