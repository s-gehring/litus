import { expect, test } from "../harness/fixtures";
import { abortRun, createSpecification, retryStep, waitForStep } from "../helpers";
import { AppPage, WorkflowCardPage } from "../pages";

test.describe("retry after error", () => {
	test.use({ scenarioName: "retry-after-error", autoMode: "manual" });

	test("errored workflow retries and advances past the failed step", async ({
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

		// First specify invocation fails (exitCode 1) — the workflow must land
		// in `error`, the failed step must be flagged, and the Retry button
		// must be the only run-control offered. A visible Abort here would
		// mean the orchestrator routed failure to cancel rather than error,
		// which is the regression this whole fix guards against.
		await waitForStep(card, "specify", "error", { timeoutMs: 60_000 });
		await expect(card.statusBadge()).toHaveClass(/\berror\b/, { timeout: 30_000 });
		await expect(card.retryAction()).toBeVisible({ timeout: 10_000 });
		await expect(card.abortAction()).toHaveCount(0);
		await expect(card.pauseAction()).toHaveCount(0);

		await retryStep(card);

		// Retry re-enters the spawn path with the same worktree as the first
		// run. If the error transition had torn down the workflow's cwd (the
		// bug this covers), the retry would come straight back with
		// `Worktree directory missing: <path>` and `specify` would flash
		// `error` a second time. Assert that specify makes it to `completed`
		// — the only proof that retry actually advanced the pipeline.
		await waitForStep(card, "specify", "completed", { timeoutMs: 60_000 });

		// Clarify emits a question → workflow reaches waiting_for_input.
		// Reaching this state end-to-end is the strongest positive signal
		// that retry → success → next step works.
		await waitForStep(card, "clarify", "waiting", { timeoutMs: 60_000 });
		await expect(card.statusBadge()).toHaveClass(/\bwaiting_for_input\b/, { timeout: 10_000 });

		// Clean termination so the per-test teardown doesn't race a still-
		// running pipeline against the server shutdown.
		await abortRun(card);
		await expect(card.statusBadge()).toHaveClass(/\bcancelled\b/, { timeout: 30_000 });
	});
});
