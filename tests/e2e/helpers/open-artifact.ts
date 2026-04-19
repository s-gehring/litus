import { expect } from "@playwright/test";
import type { ArtifactViewerPage } from "../pages/artifact-viewer";

/**
 * Open the artifact dropdown on the pipeline step with `stepDisplayName`,
 * click the entry whose visible label matches `artifactLabel`, and wait for
 * the modal viewer to render. Returns after the modal is visible.
 */
export async function openArtifact(
	viewer: ArtifactViewerPage,
	stepDisplayName: string,
	artifactLabel: string,
): Promise<void> {
	const affordance = viewer.affordanceForStep(stepDisplayName);
	await expect(affordance).toBeVisible();
	await affordance.click();
	const item = viewer.dropdownItemByLabel(artifactLabel);
	await expect(item).toBeVisible();
	await item.click();
	await expect(viewer.modal()).toBeVisible();
}
