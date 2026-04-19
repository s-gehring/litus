import { expect } from "@playwright/test";
import type { AlertsPage } from "../pages/alerts";
import type { AppPage } from "../pages/app";
import { createSpecification } from "./create-specification";

export interface TriggerFailureInput {
	specification: string;
	repo?: string;
}

/**
 * Start a workflow via the New Specification form and wait until a failure
 * alert lands on the bell badge. Used by the alerts story to drive real
 * alert events through a scripted failing `claude` invocation.
 */
export async function triggerFailure(
	app: AppPage,
	alerts: AlertsPage,
	input: TriggerFailureInput,
): Promise<void> {
	const startingCount = await currentBellCount(alerts);
	await createSpecification(app, input);
	await expect
		.poll(async () => currentBellCount(alerts), { timeout: 60_000 })
		.toBeGreaterThan(startingCount);
}

async function currentBellCount(alerts: AlertsPage): Promise<number> {
	const badge = alerts.bellCount();
	if ((await badge.count()) === 0) return 0;
	const isHidden = await badge.evaluate((el) => el.classList.contains("hidden"));
	if (isHidden) return 0;
	const raw = (await badge.textContent())?.trim() ?? "0";
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : 0;
}
