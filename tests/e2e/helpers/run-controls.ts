import { expect } from "@playwright/test";
import type { WorkflowCardPage } from "../pages/workflow-card";

export type AutomationMode = "manual" | "normal" | "full-auto";

export async function pauseRun(card: WorkflowCardPage): Promise<void> {
	const btn = card.pauseAction();
	await expect(btn).toBeVisible({ timeout: 30_000 });
	await btn.click();
}

export async function resumeRun(card: WorkflowCardPage): Promise<void> {
	const btn = card.resumeAction();
	await expect(btn).toBeVisible({ timeout: 30_000 });
	await btn.click();
}

export async function retryStep(card: WorkflowCardPage): Promise<void> {
	const btn = card.retryAction();
	await expect(btn).toBeVisible({ timeout: 30_000 });
	await btn.click();
}

export async function abortRun(card: WorkflowCardPage): Promise<void> {
	// The abort handler wraps the dispatch in a `confirm()` — auto-accept it
	// so the underlying workflow:abort message actually fires.
	card.page.once("dialog", (dialog) => {
		void dialog.accept();
	});
	const btn = card.abortAction();
	await expect(btn).toBeVisible({ timeout: 30_000 });
	await btn.click();
}

export async function forceStart(card: WorkflowCardPage): Promise<void> {
	const btn = card.forceStartAction();
	await expect(btn).toBeVisible({ timeout: 30_000 });
	await btn.click();
}

/**
 * Cycle the automation-mode toggle until it reaches `target`. The button is
 * a 3-way cycle (manual → normal → full-auto → manual), so at most two
 * clicks are required.
 */
export async function setAutomationMode(
	card: WorkflowCardPage,
	target: AutomationMode,
): Promise<void> {
	const toggle = card.autoModeToggle();
	await expect(toggle).toBeVisible({ timeout: 30_000 });
	for (let i = 0; i < 3; i++) {
		const cls = await toggle.getAttribute("class");
		if (cls?.includes(card.autoModeClass(target))) return;
		await toggle.click();
		// Wait for the server-broadcast config update to re-skin the button.
		await expect(toggle)
			.toHaveClass(new RegExp(`\\b${card.autoModeClass(target).replace("-", "\\-")}\\b`), {
				timeout: 5_000,
			})
			.catch(() => {
				// not at target yet; continue cycling
			});
	}
	await expect(toggle).toHaveClass(new RegExp(card.autoModeClass(target)));
}
