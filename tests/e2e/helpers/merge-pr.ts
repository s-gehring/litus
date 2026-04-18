import { expect } from "@playwright/test";
import type { WorkflowCardPage } from "../pages/workflow-card";

/**
 * Click the merge action in the workflow card. The harness fixture defaults
 * to manual mode so the pipeline pauses at `merge-pr` and surfaces a merge
 * action (FR-011). Fails loudly if the action never appears — silent no-op
 * helpers made it possible to "pass" without exercising the merge UI.
 */
export async function mergePullRequest(card: WorkflowCardPage): Promise<void> {
	const action = card.mergeAction();
	await expect(action).toBeVisible({ timeout: 30_000 });
	await action.click();
}
