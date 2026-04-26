import type { Workflow } from "./types";

export type EligibleFirstLevelSpec = {
	workflowId: string;
};

type WorkflowEligibilityFields = Pick<
	Workflow,
	"id" | "epicId" | "archived" | "epicDependencies" | "status"
>;

export function computeEligibleFirstLevelSpecs(
	epicId: string,
	workflows: WorkflowEligibilityFields[],
): EligibleFirstLevelSpec[] {
	return workflows
		.filter(
			(wf) =>
				wf.epicId === epicId &&
				wf.archived === false &&
				wf.epicDependencies.length === 0 &&
				wf.status === "idle",
		)
		.map((wf) => ({ workflowId: wf.id }));
}
