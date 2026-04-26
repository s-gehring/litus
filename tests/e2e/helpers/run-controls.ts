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

/**
 * Confirm the `showConfirmModal` dialog that the action-bar opens for
 * destructive buttons (abort, abort-all, retry-workflow, archive of an
 * unfinished workflow). The modal is a DOM element under
 * `.confirm-modal`, NOT a native `confirm()` dialog — the legacy native
 * dialog handlers were removed when the action bar unified onto the
 * registry-driven renderer.
 */
async function confirmModal(card: WorkflowCardPage): Promise<void> {
	const modal = card.page.locator(".confirm-modal");
	await expect(modal).toBeVisible({ timeout: 5_000 });
	await modal.locator(".btn-primary").click();
	await expect(modal).toHaveCount(0, { timeout: 5_000 });
}

/**
 * Click the whole-workflow "Reset and retry" button and confirm the modal
 * the action-bar opens.
 */
export async function retryWorkflow(card: WorkflowCardPage): Promise<void> {
	const btn = card.retryWorkflowAction();
	await expect(btn).toBeVisible({ timeout: 30_000 });
	await btn.click();
	await confirmModal(card);
}

export async function abortRun(card: WorkflowCardPage): Promise<void> {
	const btn = card.abortAction();
	await expect(btn).toBeVisible({ timeout: 30_000 });
	await btn.click();
	await confirmModal(card);
}

export async function forceStart(card: WorkflowCardPage): Promise<void> {
	const btn = card.forceStartAction();
	await expect(btn).toBeVisible({ timeout: 30_000 });
	await btn.click();
}

/**
 * Cycle the automation-mode toggle until it reaches `target`. The button is
 * a 3-way cycle (manual → normal → full-auto → manual), so at most two
 * clicks are required. Dashes don't need escaping outside a character
 * class, so the regex uses the class string directly.
 */
export async function setAutomationMode(
	card: WorkflowCardPage,
	target: AutomationMode,
): Promise<void> {
	const toggle = card.autoModeToggle();
	await expect(toggle).toBeVisible({ timeout: 30_000 });
	const targetClass = card.autoModeClass(target);
	const targetRegex = new RegExp(`\\b${targetClass}\\b`);
	for (let i = 0; i < 3; i++) {
		const cls = (await toggle.getAttribute("class")) ?? "";
		if (cls.includes(targetClass)) return;
		await toggle.click();
		// Wait for the server-broadcast config update to swap the mode
		// class before we sample again. We poll for any class change away
		// from the pre-click state, then loop to re-read.
		await expect
			.poll(async () => (await toggle.getAttribute("class")) ?? "", { timeout: 5_000 })
			.not.toBe(cls);
	}
	await expect(toggle).toHaveClass(targetRegex);
}
