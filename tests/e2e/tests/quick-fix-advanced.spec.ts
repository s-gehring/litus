import { expect, test } from "../harness/fixtures";
import { abortRun, mergePullRequest, retryStep, startQuickFix, waitForStep } from "../helpers";
import { AppPage, QuestionPromptPage, WorkflowCardPage } from "../pages";

test.describe("quick-fix advanced", () => {
	test.describe("retry after error", () => {
		test.use({ scenarioName: "quick-fix-retry", autoMode: "manual" });

		test("quick-fix retries fix-implement and advances to completed", async ({
			page,
			server,
			sandbox,
		}) => {
			test.setTimeout(120_000);
			const app = new AppPage(page);
			await app.goto(server.baseUrl);
			await app.waitConnected();

			await startQuickFix(app, {
				description: "Fix typo in the greeting helper.",
				repo: sandbox.targetRepo,
			});

			const card = new WorkflowCardPage(page);

			await waitForStep(card, "fix-implement", "error", { timeoutMs: 60_000 });
			await expect(card.statusBadge()).toHaveClass(/\berror\b/, { timeout: 30_000 });
			await expect(card.retryAction()).toBeVisible({ timeout: 10_000 });
			await expect(card.abortAction()).toBeVisible({ timeout: 10_000 });
			await expect(card.pauseAction()).toHaveCount(0);
			await expect(card.resumeAction()).toHaveCount(0);

			await retryStep(card);

			await waitForStep(card, "fix-implement", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "monitor-ci", "completed", { timeoutMs: 60_000 });

			await mergePullRequest(card);

			await waitForStep(card, "sync-repo", "completed", { timeoutMs: 60_000 });
			await expect(card.statusBadge()).toHaveClass(/completed/, { timeout: 30_000 });
			await expect(card.stepIndicator("specify")).toHaveCount(0);
		});
	});

	test.describe("abort from waiting_for_input", () => {
		test.use({ scenarioName: "quick-fix-abort", autoMode: "manual" });

		test("abort transitions quick-fix to aborted", async ({ page, server, sandbox }) => {
			test.setTimeout(120_000);
			const app = new AppPage(page);
			await app.goto(server.baseUrl);
			await app.waitConnected();

			await startQuickFix(app, {
				description: "Fix typo in the greeting helper.",
				repo: sandbox.targetRepo,
			});

			const card = new WorkflowCardPage(page);

			await waitForStep(card, "fix-implement", "waiting", { timeoutMs: 60_000 });
			await expect(card.statusBadge()).toHaveClass(/\bwaiting_for_input\b/, { timeout: 10_000 });

			await abortRun(card);

			// Parity: run-controls.spec.ts:85-88 (SC-004) — aborted status + all three
			// run-time actions absent. Shortening this block would mask a regression.
			await expect(card.statusBadge()).toHaveClass(/\baborted\b/, { timeout: 30_000 });
			await expect(card.pauseAction()).toHaveCount(0);
			await expect(card.resumeAction()).toHaveCount(0);
			await expect(card.abortAction()).toHaveCount(0);

			await expect(card.retryWorkflowAction()).toBeVisible({ timeout: 10_000 });
		});
	});

	test.describe("full-auto through merged PR", () => {
		test.use({ scenarioName: "quick-fix-full-auto", autoMode: "full-auto" });

		test("full-auto drives quick-fix to completed without operator input", async ({
			page,
			server,
			sandbox,
		}) => {
			test.setTimeout(180_000);
			const app = new AppPage(page);
			await app.goto(server.baseUrl);
			await app.waitConnected();

			await startQuickFix(app, {
				description: "Fix typo in the greeting helper.",
				repo: sandbox.targetRepo,
			});

			const card = new WorkflowCardPage(page);

			// SC-005: confirm full-auto never surfaces the operator merge action.
			// Accept running OR completed — full-auto can race through merge-pr so fast
			// Playwright's polling misses the transient running state.
			await expect(card.stepIndicator("merge-pr")).toHaveClass(/\bstep-(running|completed)\b/, {
				timeout: 60_000,
			});
			await expect(card.mergeAction()).toHaveCount(0);

			await waitForStep(card, "merge-pr", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "sync-repo", "completed", { timeoutMs: 60_000 });
			await expect(card.statusBadge()).toHaveClass(/completed/, { timeout: 30_000 });

			await expect(card.stepIndicator("fix-ci")).not.toHaveClass(/\b(running|completed|error)\b/);
			await expect(card.stepIndicator("feedback-implementer")).not.toHaveClass(
				/\b(running|completed|error)\b/,
			);
			await expect(card.stepIndicator("specify")).toHaveCount(0);
		});
	});

	test.describe("question panel mid-run", () => {
		test.use({ scenarioName: "quick-fix-question", autoMode: "manual" });

		test("question panel mounts during quick-fix run", async ({ page, server, sandbox }) => {
			test.setTimeout(120_000);
			const app = new AppPage(page);
			await app.goto(server.baseUrl);
			await app.waitConnected();

			await startQuickFix(app, {
				description: "Fix typo in the greeting helper.",
				repo: sandbox.targetRepo,
			});

			const card = new WorkflowCardPage(page);

			await waitForStep(card, "fix-implement", "waiting", { timeoutMs: 60_000 });
			await expect(card.statusBadge()).toHaveClass(/\bwaiting_for_input\b/, { timeout: 10_000 });

			const prompt = new QuestionPromptPage(page);
			await expect(prompt.panel()).toBeVisible({ timeout: 10_000 });
			await expect(prompt.questionContent()).toContainText("README reference");

			await abortRun(card);
			await expect(card.statusBadge()).toHaveClass(/\baborted\b/, { timeout: 30_000 });
		});
	});
});
