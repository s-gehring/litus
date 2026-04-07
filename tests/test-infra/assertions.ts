import type { PipelineStepStatus, Workflow, WorkflowStatus } from "../../src/types";

/**
 * Assert a workflow has the expected status, with rich error messages
 * including current step and error details.
 */
export function expectWorkflowStatus(workflow: Workflow, expectedStatus: WorkflowStatus): void {
	if (workflow.status !== expectedStatus) {
		const currentStep = workflow.steps[workflow.currentStepIndex];
		const stepInfo = currentStep ? `, current step: ${currentStep.name}` : "";
		const errorInfo = currentStep?.error ? `, error: ${currentStep.error}` : "";
		throw new Error(
			`Expected workflow status '${expectedStatus}' but got '${workflow.status}'${stepInfo}${errorInfo}`,
		);
	}
}

/**
 * Assert a workflow has all required fields and valid structure.
 */
export function expectValidWorkflow(workflow: Workflow): void {
	const missing: string[] = [];

	if (!workflow.id) missing.push("id");
	if (!workflow.specification) missing.push("specification");
	if (!workflow.status) missing.push("status");
	if (!workflow.steps || !Array.isArray(workflow.steps)) missing.push("steps (must be array)");
	if (typeof workflow.currentStepIndex !== "number") missing.push("currentStepIndex");
	if (!workflow.createdAt) missing.push("createdAt");
	if (!workflow.updatedAt) missing.push("updatedAt");
	if (!workflow.worktreeBranch) missing.push("worktreeBranch");

	if (missing.length > 0) {
		throw new Error(`Invalid workflow: missing required field(s): ${missing.join(", ")}`);
	}

	// Validate each step has required fields
	for (let i = 0; i < workflow.steps.length; i++) {
		const step = workflow.steps[i];
		if (!step.name) missing.push(`steps[${i}].name`);
		if (!step.displayName) missing.push(`steps[${i}].displayName`);
		if (!step.status) missing.push(`steps[${i}].status`);
	}

	if (missing.length > 0) {
		throw new Error(`Invalid workflow: missing required field(s): ${missing.join(", ")}`);
	}

	if (workflow.steps.length === 0) {
		throw new Error("Invalid workflow: steps array is empty");
	}
}

/**
 * Assert a specific step in a workflow has the expected status.
 */
export function expectStepStatus(
	workflow: Workflow,
	stepName: string,
	expectedStatus: PipelineStepStatus,
): void {
	const step = workflow.steps.find((s) => s.name === stepName);
	if (!step) {
		throw new Error(
			`Step '${stepName}' not found in workflow. Available steps: ${workflow.steps.map((s) => s.name).join(", ")}`,
		);
	}
	if (step.status !== expectedStatus) {
		throw new Error(
			`Expected step '${stepName}' status '${expectedStatus}' but got '${step.status}'`,
		);
	}
}
