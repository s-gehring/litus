import { expect, test } from "../harness/fixtures";
import { createSpecification, pauseRun, waitForStep } from "../helpers";
import { AppPage, FeedbackPanelPage, WorkflowCardPage } from "../pages";

test.describe("resume-with-feedback (User Story 1)", () => {
	test.use({ scenarioName: "resume-with-feedback", autoMode: "manual" });

	test("paused mid-step → submit feedback → workflow returns to running on the same step", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(120_000);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createSpecification(app, {
			specification: "Add a dark mode toggle to the application settings.",
			repo: sandbox.targetRepo,
		});

		const card = new WorkflowCardPage(page);

		// Specify is delayMs:2500 in the scenario so we can catch the running
		// state and pause it. The init event has already fired so the step
		// has a captured sessionId, which makes the resume-with-feedback
		// predicate satisfied (FR-001).
		await waitForStep(card, "specify", "running", { timeoutMs: 30_000 });
		await pauseRun(card);

		await expect(card.statusBadge()).toHaveClass(/paused/, { timeout: 10_000 });

		// FR-001/FR-009: Provide Feedback action surfaces on a paused step
		// with a captured CLI session, even when the step is NOT merge-pr.
		const provideFeedback = card.provideFeedbackAction();
		await expect(provideFeedback).toBeVisible({ timeout: 10_000 });

		// Open the panel and submit non-empty feedback.
		await provideFeedback.click();
		const panel = new FeedbackPanelPage(page);
		await expect(panel.panel()).toBeVisible({ timeout: 10_000 });
		await panel.input().fill("Please mention dark and light themes equally.");
		await panel.input().dispatchEvent("input");
		await panel.submitButton().click();
		await expect(panel.panel()).toBeHidden({ timeout: 10_000 });

		// Workflow returns to running on the SAME step (currentStepIndex
		// unchanged) — the orchestrator re-spawns the CLI with --resume and
		// the injected prompt. The plain-Resume action is replaced by the
		// running-state Pause action.
		await expect(card.statusBadge()).toHaveClass(/\b(running|waiting_for_input)\b/, {
			timeout: 30_000,
		});
	});
});
