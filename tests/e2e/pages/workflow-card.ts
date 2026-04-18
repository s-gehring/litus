import type { Locator, Page } from "@playwright/test";

export type PipelineStepName =
	| "setup"
	| "specify"
	| "clarify"
	| "plan"
	| "tasks"
	| "implement"
	| "review"
	| "implement-review"
	| "commit-push-pr"
	| "monitor-ci"
	| "fix-ci"
	| "feedback-implementer"
	| "merge-pr"
	| "sync-repo";

export type StepState = "pending" | "running" | "waiting" | "paused" | "completed" | "error";

const STATE_CLASS: Record<StepState, string> = {
	pending: "step-pending",
	running: "step-running",
	waiting: "step-waiting",
	paused: "step-paused",
	completed: "step-completed",
	error: "step-error",
};

const DISPLAY_NAME: Record<PipelineStepName, string> = {
	setup: "Setup",
	specify: "Specifying",
	clarify: "Clarifying",
	plan: "Planning",
	tasks: "Generating Tasks",
	implement: "Implementing",
	review: "Reviewing",
	"implement-review": "Fixing Review",
	"commit-push-pr": "Creating PR",
	"monitor-ci": "Monitoring CI",
	"fix-ci": "Fixing CI",
	"feedback-implementer": "Applying Feedback",
	"merge-pr": "Merging PR",
	"sync-repo": "Syncing Repository",
};

export class WorkflowCardPage {
	constructor(public readonly page: Page) {}

	pipelineContainer(): Locator {
		return this.page.locator("#pipeline-steps");
	}

	stepIndicator(step: PipelineStepName): Locator {
		return this.pipelineContainer()
			.locator(".pipeline-step")
			.filter({ has: this.page.locator(`.step-label`, { hasText: DISPLAY_NAME[step] }) });
	}

	stepStateClass(state: StepState): string {
		return STATE_CLASS[state];
	}

	statusBadge(): Locator {
		return this.page.locator("#workflow-status");
	}

	prLink(): Locator {
		return this.page.locator("#pr-link");
	}

	detailActions(): Locator {
		return this.page.locator("#detail-actions");
	}

	/**
	 * The UI merge action shown when the pipeline pauses at `merge-pr` in
	 * manual mode. Selected by the `action-resume` test id rendered on every
	 * detail-action button (see `renderActionButtons` in workflow-window.ts).
	 */
	mergeAction(): Locator {
		return this.detailActions().locator('[data-testid="action-resume"]');
	}
}
