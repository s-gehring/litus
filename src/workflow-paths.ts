import type { Workflow } from "./types";

export function requireWorktreePath(workflow: Workflow): string {
	if (!workflow.worktreePath) {
		throw new Error(
			`Workflow ${workflow.id} has no worktreePath — cannot determine working directory`,
		);
	}
	return workflow.worktreePath;
}

export function requireTargetRepository(workflow: Workflow): string {
	if (!workflow.targetRepository) {
		throw new Error(
			`Workflow ${workflow.id} has no targetRepository — cannot determine target directory`,
		);
	}
	return workflow.targetRepository;
}
