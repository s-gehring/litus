import { expect } from "@playwright/test";
import type { PipelineStepName, StepState, WorkflowCardPage } from "../pages/workflow-card";

export interface WaitForStepOptions {
	timeoutMs?: number;
}

export async function waitForStep(
	card: WorkflowCardPage,
	step: PipelineStepName,
	state: StepState,
	options: WaitForStepOptions = {},
): Promise<void> {
	const indicator = card.stepIndicator(step);
	await expect(indicator).toHaveClass(new RegExp(card.stepStateClass(state)), {
		timeout: options.timeoutMs ?? 30_000,
	});
}
