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
	| "fix-implement"
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
	"fix-implement": "Fix Implementation",
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

	pauseAction(): Locator {
		return this.detailActions().locator('[data-testid="action-pause"]');
	}

	/**
	 * The detail-action button rendered by `renderDetailActions` in
	 * `detail-actions.ts`. In manual mode this doubles as both the
	 * post-pause Resume control and the merge-pr Merge control — the label
	 * differs but the test id does not. Callers choose `resumeAction()` vs.
	 * `mergeAction()` to encode intent at the call site.
	 */
	resumeAction(): Locator {
		return this.detailActions().locator('[data-testid="action-resume"]');
	}

	mergeAction(): Locator {
		return this.resumeAction();
	}

	retryAction(): Locator {
		return this.detailActions().locator('[data-testid="action-retry-step"]');
	}

	retryWorkflowAction(): Locator {
		return this.detailActions().locator('[data-testid="action-retry-workflow"]');
	}

	abortAction(): Locator {
		return this.detailActions().locator('[data-testid="action-abort"]');
	}

	forceStartAction(): Locator {
		return this.detailActions().locator('[data-testid="action-force-start"]');
	}

	provideFeedbackAction(): Locator {
		return this.detailActions().locator('[data-testid="action-provide-feedback"]');
	}

	autoModeToggle(): Locator {
		return this.page.locator("#btn-auto-mode");
	}

	autoModeClass(mode: "manual" | "normal" | "full-auto"): string {
		return `mode-${mode}`;
	}
}
