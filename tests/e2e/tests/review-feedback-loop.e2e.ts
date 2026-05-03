import { expect, test } from "../harness/fixtures";
import { answerClarifyingQuestion, createSpecification, demoPause, waitForStep } from "../helpers";
import { AppPage, FeedbackPanelPage, WorkflowCardPage } from "../pages";

test.describe("review/feedback loop", () => {
	test.use({ scenarioName: "review-feedback-loop", autoMode: "manual" });

	test("provide feedback re-runs feedback-implementer and returns to merge-pr pause", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(360_000);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();
		await demoPause(page);

		await createSpecification(app, {
			specification: "Add a dark mode toggle to the application settings.",
			repo: sandbox.targetRepo,
		});
		await demoPause(page);

		const card = new WorkflowCardPage(page);

		await waitForStep(card, "clarify", "waiting", { timeoutMs: 60_000 });
		await demoPause(page);
		await answerClarifyingQuestion(card, "yes", { expectQuestionContains: "dark mode" });
		await demoPause(page);

		// Progress to the manual-mode merge-pr pause. The `Provide Feedback`
		// action is only present on that pause.
		await expect(card.provideFeedbackAction()).toBeVisible({ timeout: 120_000 });
		await demoPause(page); // viewer sees the merge-pr pause with feedback option

		const panelPage = new FeedbackPanelPage(page);

		// First iteration: open panel, assert empty-history state, submit text.
		await card.provideFeedbackAction().click();
		await expect(panelPage.panel()).toBeVisible({ timeout: 10_000 });
		await expect(panelPage.emptyHistoryMessage()).toBeVisible();
		await demoPause(page); // viewer sees the empty-history panel
		await panelPage.input().fill("Please tighten the copy on the toggle label.");
		await demoPause(page); // viewer reads the typed feedback before submit
		await panelPage.submitButton().click();
		await expect(panelPage.panel()).toBeHidden({ timeout: 10_000 });

		// Feedback-implementer runs. Wait for it to start (step transitions to
		// running) then to complete — the scripted response is a `no changes`
		// outcome, which routes the workflow back to a merge-pr pause.
		await waitForStep(card, "feedback-implementer", "completed", { timeoutMs: 60_000 });
		await demoPause(page);

		// Back at merge-pr pause, the Provide Feedback action is available again.
		// Re-open the panel and assert the prior iteration is preserved in history.
		await expect(card.provideFeedbackAction()).toBeVisible({ timeout: 60_000 });
		await card.provideFeedbackAction().click();
		await expect(panelPage.panel()).toBeVisible({ timeout: 10_000 });
		await expect(panelPage.historyEntries()).toHaveCount(1);
		await demoPause(page); // viewer sees the history entry from the first iteration
		// Scenario scripts a `no changes` feedback-implementer outcome;
		// the rendered entry should carry the matching outcome badge. This
		// catches a regression that silently drops the outcome payload —
		// without it, the count-only assertion above passes even if the
		// badge class never appears (SC-004 control-named failure).
		await expect(panelPage.historyEntries().first().locator(".feedback-entry-outcome")).toHaveClass(
			/outcome-no-changes/,
		);
	});
});
