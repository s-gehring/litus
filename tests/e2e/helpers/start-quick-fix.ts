import { expect } from "@playwright/test";
import type { AppPage } from "../pages/app";
import { QuickFixFormPage } from "../pages/quick-fix-form";

export interface StartQuickFixInput {
	description: string;
	repo?: string;
}

export async function startQuickFix(app: AppPage, input: StartQuickFixInput): Promise<void> {
	await app.quickFixButton().click();
	const form = new QuickFixFormPage(app.page);
	await expect(form.modal()).toBeVisible();
	if (input.repo) {
		await form.repoInput().fill(input.repo);
	}
	await form.descriptionInput().fill(input.description);
	await expect(form.submitButton()).toBeEnabled();
	await form.submitButton().click();
	await expect(form.modal()).toBeHidden({ timeout: 15_000 });
}
