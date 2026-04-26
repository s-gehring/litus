import { expect, test } from "../harness/fixtures";
import { createSpecification, openArtifact, waitForStep } from "../helpers";
import { AppPage, ArtifactViewerPage, WorkflowCardPage } from "../pages";

test.describe("review-artifacts-loop", () => {
	test.use({ scenarioName: "review-artifacts-loop", autoMode: "full-auto" });

	test("both review iterations and their 'Fixing Review' snapshots are listed", async ({
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
			specification: "Review artifacts loop e2e",
			repo: sandbox.targetRepo,
		});

		// Drive through two review/implement-review iterations. The scripted
		// classifier returns "major" on the first call (so the cycle loops back
		// to review) and "nit" on the second (so the cycle advances). Wait for
		// commit-push-pr to leave `pending` — that is the soonest point at
		// which every review + implement-review snapshot is on disk.
		const cppStep = card.stepIndicator("commit-push-pr");
		await expect(cppStep).not.toHaveClass(/\bstep-pending\b/, {
			timeout: 180_000,
		});

		// Guard that we really went through two iterations: the review badge
		// counter rendered in `pipeline-steps.ts` tracks the completed cycle
		// count. Pre-fix the counter was bumped on the review → implement-review
		// hop, so two completed cycles rendered "×3". Post-fix the badge must
		// render "×2" once commit-push-pr is reachable.
		const reviewBadge = card.stepIndicator("review").locator(".review-badge");
		await expect(reviewBadge).toHaveText("×2", { timeout: 60_000 });

		// Both review iterations must expose an artifact dropdown. The pre-fix
		// implement-review snapshot was silently dropped (the snapshotter
		// derived its filename from an already-bumped iteration and the file
		// did not exist on disk), so this assertion is the core regression
		// guard: the "Fixing Review" step MUST surface at least one artifact.
		const reviewAffordance = viewer.affordanceForStep("Reviewing");
		const fixAffordance = viewer.affordanceForStep("Fixing Review");
		await expect(reviewAffordance).toBeVisible({ timeout: 60_000 });
		await expect(fixAffordance).toBeVisible({ timeout: 60_000 });

		// Open the Review dropdown and assert BOTH iterations are present —
		// the first review under `code-review.md` and the second under
		// `code-review-2.md`.
		await reviewAffordance.click();
		await expect(viewer.dropdownItemByLabel("code-review.md")).toBeVisible();
		await expect(viewer.dropdownItemByLabel("code-review-2.md")).toBeVisible();
		// Close the dropdown by clicking the affordance again (toggle).
		await reviewAffordance.click();

		// Open the Fixing Review dropdown and assert BOTH iterations' after-fix
		// snapshots are present, labeled with the "(after fixes)" suffix the
		// artifact-list builder appends for implement-review entries.
		await fixAffordance.click();
		await expect(viewer.dropdownItemByLabel("code-review.md (after fixes)")).toBeVisible();
		await expect(viewer.dropdownItemByLabel("code-review-2.md (after fixes)")).toBeVisible();
		await fixAffordance.click();

		// Content round-trip: open the first-iteration "Fixing Review"
		// artifact and verify it contains the appended response. Before the
		// fix, this entry did not exist at all — opening it would have failed
		// the dropdown-item assertion above. Opening + asserting text here
		// guards against a regression where the snapshot is registered but
		// points at the unmodified pre-fix content (e.g. snapshotted before
		// `implement-review` wrote its output).
		await openArtifact(viewer, "Fixing Review", "code-review.md (after fixes)");
		await expect(viewer.modalBody()).toContainText("Response to review 1", { timeout: 15_000 });
		await page.keyboard.press("Escape");
		await expect(viewer.modal()).toBeHidden();

		// Also verify the BEFORE-fix review artifact does NOT contain the
		// response text. This proves the two snapshots are distinct files —
		// a regression where both affordances pointed at the same snapshot
		// would otherwise pass the pair of dropdown-visibility assertions
		// above without actually fixing the bug.
		await openArtifact(viewer, "Reviewing", "code-review.md");
		await expect(viewer.modalBody()).toContainText("Code review 1", { timeout: 15_000 });
		await expect(viewer.modalBody()).not.toContainText("Response to review 1");
		await page.keyboard.press("Escape");
		await expect(viewer.modal()).toBeHidden();

		// Sanity wait: the workflow should eventually finish in full-auto.
		// Not strictly required for the artifact assertions above, but lets
		// a failure mode where the scenario diverges surface cleanly rather
		// than as a stray timeout in a later test.
		await waitForStep(card, "merge-pr", "completed", { timeoutMs: 120_000 });
	});
});
