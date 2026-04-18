import { expect } from "@playwright/test";
import type { AppPage } from "../pages/app";
import { SpecFormPage } from "../pages/spec-form";

export interface CreateSpecificationInput {
	specification: string;
	repo?: string;
}

export async function createSpecification(
	app: AppPage,
	input: CreateSpecificationInput,
): Promise<void> {
	await app.newSpecButton().click();
	const form = new SpecFormPage(app.page);
	await expect(form.modal()).toBeVisible();
	if (input.repo) {
		await form.repoInput().fill(input.repo);
	}
	await form.specificationInput().fill(input.specification);
	await form.submitButton().click();
	await expect(form.modal()).toBeHidden({ timeout: 15_000 });
}
