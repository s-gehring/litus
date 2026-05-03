import { expect, test } from "../harness/fixtures";
import { abortRun, createSpecification, retryWorkflow, waitForStep } from "../helpers";
import { AppPage, WorkflowCardPage } from "../pages";

/**
 * End-to-end coverage for the whole-workflow "Retry workflow" reset that
 * this branch introduces (distinct from the per-step "Retry step" action
 * covered in `retry-after-error.e2e.ts`).
 *
 * The action resets an `error` or `aborted` workflow back to Setup,
 * deleting branch/worktree/artifacts. After a successful reset the
 * workflow must land in `idle` and the reset/retry-step buttons must
 * disappear so the operator can't double-invoke them.
 */
test.describe("retry workflow (reset to Setup)", () => {
	test.use({ scenarioName: "retry-after-error", autoMode: "manual" });

	test("reset from error auto-relaunches the standalone workflow", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(120_000);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createSpecification(app, {
			specification: "Add a dark mode toggle to the application settings.",
			repo: sandbox.targetRepo,
		});

		const card = new WorkflowCardPage(page);

		await waitForStep(card, "specify", "error", { timeoutMs: 60_000 });
		await expect(card.statusBadge()).toHaveClass(/\berror\b/, { timeout: 30_000 });

		// "Retry workflow" surfaces alongside "Retry step" and "Abort" in the
		// error state — it's the third recovery option.
		await expect(card.retryWorkflowAction()).toBeVisible({ timeout: 10_000 });

		await retryWorkflow(card);

		// fix/022: Standalone workflows (no epicId) auto-relaunch after a
		// successful reset — the Start button only renders for epic-attached
		// workflows, so without auto-start the operator's "Restart" click
		// would silently strand the workflow at idle. The reset itself
		// transitions through `idle` → `running`; assert the eventual state.
		await expect(card.statusBadge()).not.toHaveClass(/\b(error|aborted|idle)\b/, {
			timeout: 30_000,
		});

		// After reset the retry actions must be gone — re-clicking them on a
		// running/errored-again workflow is fine via a fresh state, but the
		// reset itself should have cleared the previous attempt's error flag
		// from the specify step before re-running.
		await expect(card.retryWorkflowAction()).toHaveCount(0);
	});

	test("reset from aborted auto-relaunches the standalone workflow", async ({
		page,
		server,
		sandbox,
	}) => {
		// `aborted` is a terminal state, but Retry workflow is still offered
		// because the managed branch/worktree/artifacts otherwise stick
		// around until the whole workflow is purged. This test covers the
		// aborted → reset path that the error-state test does not.
		test.setTimeout(120_000);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createSpecification(app, {
			specification: "Add a dark mode toggle to the application settings.",
			repo: sandbox.targetRepo,
		});

		const card = new WorkflowCardPage(page);

		// Drive to error first, then abort — aborted is only reachable via an
		// explicit user action, not directly from a scripted failure.
		await waitForStep(card, "specify", "error", { timeoutMs: 60_000 });
		await abortRun(card);
		await expect(card.statusBadge()).toHaveClass(/\baborted\b/, { timeout: 30_000 });

		// Retry workflow must still be available from `aborted` — the
		// distinguishing feature of this action vs. the existing per-step
		// retry, which is error-only.
		await expect(card.retryWorkflowAction()).toBeVisible({ timeout: 10_000 });

		await retryWorkflow(card);

		// fix/022: standalone workflows auto-relaunch — same rationale as the
		// error-path test above.
		await expect(card.statusBadge()).not.toHaveClass(/\b(error|aborted|idle)\b/, {
			timeout: 30_000,
		});
		await expect(card.retryWorkflowAction()).toHaveCount(0);
	});
});
