import { expect, type Page } from "@playwright/test";
import { EpicTree } from "../pages/epic-tree";

export interface StartChildSpecOptions {
	page: Page;
	specTitle: string;
}

/**
 * Click a child row in the epic tree to open its workflow card. Resolves when
 * a matching workflow card is visible on the strip. Children are identified
 * by their spec title as it appears in `.tree-node-title`.
 */
export async function startChildSpec(opts: StartChildSpecOptions): Promise<void> {
	const { page, specTitle } = opts;
	const tree = new EpicTree(page);
	const row = tree.childRowByTitle(specTitle);
	await row.scrollIntoViewIfNeeded();
	await row.click();

	const card = page.locator(".workflow-card").filter({ hasText: specTitle });
	await expect(card.first()).toBeVisible({ timeout: 15_000 });
}
