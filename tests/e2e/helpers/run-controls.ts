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
	// The abort handler wraps the dispatch in a `confirm()` — auto-accept
	// it so the underlying workflow:abort message actually fires. Register
	// a scoped listener and remove it after the dialog is handled (or the
	// click settles with no dialog) so a later stray dialog isn't silently
	// accepted on this page.
	const onDialog = (dialog: import("@playwright/test").Dialog): void => {
		void dialog.accept();
	};
	card.page.on("dialog", onDialog);
	try {
		const btn = card.abortAction();
		await expect(btn).toBeVisible({ timeout: 30_000 });
		const dialogSettled = card.page
			.waitForEvent("dialog", { timeout: 5_000 })
			.catch(() => undefined);
		await btn.click();
		await dialogSettled;
	} finally {
		card.page.off("dialog", onDialog);
	}
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
