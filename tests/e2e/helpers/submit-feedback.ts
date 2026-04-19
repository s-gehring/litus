import { expect } from "@playwright/test";
import { FeedbackPanelPage } from "../pages/feedback-panel";
import type { WorkflowCardPage } from "../pages/workflow-card";

/**
 * Open the feedback panel (via the `Provide Feedback` detail action) and
 * submit the given text. Asserts the panel is visible before typing so a
 * missing or hidden panel fails loudly instead of silently no-op'ing.
 */
export async function submitFeedback(card: WorkflowCardPage, text: string): Promise<void> {
	const action = card.provideFeedbackAction();
	await expect(action).toBeVisible({ timeout: 30_000 });
	await action.click();

	const panel = new FeedbackPanelPage(card.page);
	await expect(panel.panel()).toBeVisible({ timeout: 10_000 });
	await panel.input().fill(text);
	await panel.submitButton().click();
	await expect(panel.panel()).toBeHidden({ timeout: 10_000 });
}
