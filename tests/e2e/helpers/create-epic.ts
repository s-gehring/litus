import { expect, type Page } from "@playwright/test";
import { AppPage } from "../pages/app";
import { EpicFormPage } from "../pages/epic-form";

export interface CreateEpicOptions {
	page: Page;
	description: string;
	repo: string;
	/** Whether to click "Create & Start" (default) or "Create" only. */
	start?: boolean;
}

/**
 * Open the New Epic modal from the dashboard, fill in repo + description,
 * and submit. Resolves when the modal has closed (decomposition is running
 * in the background). Caller should then wait on the epic tree or detail
 * surface.
 */
export async function createEpic(opts: CreateEpicOptions): Promise<void> {
	const { page, description, repo, start = true } = opts;
	const app = new AppPage(page);
	await app.newEpicButton().click();

	const form = new EpicFormPage(page);
	await expect(form.modal()).toBeVisible();
	await form.repoInput().fill(repo);
	await form.descriptionInput().fill(description);

	const submit = start ? form.createAndStartButton() : form.createButton();
	await submit.click();

	await expect(form.modal()).toBeHidden({ timeout: 15_000 });
}
