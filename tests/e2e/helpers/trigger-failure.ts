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
	const startingCount = await alerts.currentBellCount();
	await createSpecification(app, input);
	await expect
		.poll(async () => alerts.currentBellCount(), { timeout: 60_000 })
		.toBeGreaterThan(startingCount);
}
