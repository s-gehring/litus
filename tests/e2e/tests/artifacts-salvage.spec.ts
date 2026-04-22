import { expect, test } from "../harness/fixtures";
import { createSpecification, openArtifact, waitForStep } from "../helpers";
import { AppPage, ArtifactViewerPage, WorkflowCardPage } from "../pages";

// Regression: the agent writes a complete manifest into the artifacts output
// directory, then the CLI is killed (idle timeout / wall-clock timeout /
// non-zero exit). Before the fix, the orchestrator marked the artifacts step
// as error and a retry looped forever because the agent correctly reported
// "already done" and emitted no fresh tool activity. After the fix, the step
// salvages the manifest on disk and the pipeline advances to merge-pr.
test.describe("artifacts-salvage", () => {
	test.use({ scenarioName: "artifacts-salvage", autoMode: "full-auto" });

	test("CLI exits non-zero after writing manifest → step completes from salvaged files", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(240_000);

		const app = new AppPage(page);
		const card = new WorkflowCardPage(page);
		const viewer = new ArtifactViewerPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createSpecification(app, {
			specification: "Artifacts salvage e2e",
			repo: sandbox.targetRepo,
		});

		// The pipeline must reach commit-push-pr even though the artifacts step
		// received a non-zero CLI exit — this proves the orchestrator salvaged
		// the manifest the fake wrote before exiting.
		await waitForStep(card, "commit-push-pr", "completed", { timeoutMs: 180_000 });

		// The salvaged file must surface as a real artifact on the card.
		const artifactsAffordance = viewer.affordanceForStep("Generating Artifacts");
		await expect(artifactsAffordance).toBeVisible({ timeout: 60_000 });
		await openArtifact(viewer, "Generating Artifacts", "summary.md");
		await expect(viewer.modalBody()).toContainText(
			"Written by the agent before the CLI was killed.",
			{
				timeout: 15_000,
			},
		);
		await page.keyboard.press("Escape");
		await expect(viewer.modal()).toBeHidden();

		// Sanity: pipeline continues through merge-pr as it would have without
		// the CLI kill.
		await waitForStep(card, "merge-pr", "completed", { timeoutMs: 120_000 });
	});
});
