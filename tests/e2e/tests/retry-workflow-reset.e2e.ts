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

	test("reset from error returns workflow to idle and hides retry actions", async ({
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
		// error state — it's the third recovery option and the only one this
		// branch adds.
		await expect(card.retryWorkflowAction()).toBeVisible({ timeout: 10_000 });

		await retryWorkflow(card);

		// Reset transitions status → idle. The broadcast is synchronous after
		// persist so the badge should flip quickly; allow a generous timeout
		// to absorb WS round-trip variance.
		await expect(card.statusBadge()).toHaveClass(/\bidle\b/, { timeout: 30_000 });

		// After reset the retry actions must be gone — re-clicking them on an
		// idle workflow would be a no-op server-side but leaving them visible
		// is a confusing-state bug. "Retry workflow" specifically requires
		// error/aborted, so it must vanish.
		await expect(card.retryWorkflowAction()).toHaveCount(0);
		await expect(card.retryAction()).toHaveCount(0);

		// The specify step must be back to pending — the error flag from the
		// failed first invocation should have been cleared by the reset.
		const specifyStep = card.stepIndicator("specify");
		await expect(specifyStep).not.toHaveClass(/\bstep-error\b/);
	});

	test("reset from aborted returns workflow to idle", async ({ page, server, sandbox }) => {
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
		// distinguishing feature of this branch vs. the existing per-step
		// retry, which is error-only.
		await expect(card.retryWorkflowAction()).toBeVisible({ timeout: 10_000 });

		await retryWorkflow(card);

		await expect(card.statusBadge()).toHaveClass(/\bidle\b/, { timeout: 30_000 });
		await expect(card.retryWorkflowAction()).toHaveCount(0);
	});
});
