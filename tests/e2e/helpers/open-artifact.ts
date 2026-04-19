import { expect } from "@playwright/test";
import type { ArtifactViewerPage } from "../pages/artifact-viewer";

/**
 * Open the artifact dropdown on the pipeline step whose rendered `.step-label`
 * text matches `stepLabelText`, click the entry whose visible label matches
 * `artifactLabel`, and wait for the modal viewer to render. Returns after the
 * modal is visible.
 *
 * `stepLabelText` is the visible label, NOT the canonical `displayName` from
 * `PIPELINE_STEPS` — these coincide today but diverge if the UI ever
 * decorates the rendered label (e.g. `"Specifying — running"`).
 */
export async function openArtifact(
	viewer: ArtifactViewerPage,
	stepLabelText: string,
	artifactLabel: string,
): Promise<void> {
	const affordance = viewer.affordanceForStep(stepLabelText);
	await expect(affordance).toBeVisible();
	await affordance.click();
	const item = viewer.dropdownItemByLabel(artifactLabel);
	await expect(item).toBeVisible();
	await item.click();
	await expect(viewer.modal()).toBeVisible();
}
