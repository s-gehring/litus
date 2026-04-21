import { expect, test } from "../harness/fixtures";
import {
	answerClarifyingQuestion,
	createSpecification,
	mergePullRequest,
	waitForStep,
} from "../helpers";
import { AppPage, WorkflowCardPage } from "../pages";

test.describe("CI failure → fix → re-monitor loop", () => {
	test.describe("recovers from a single red CI run", () => {
		test.use({ scenarioName: "ci-failure-and-fix", autoMode: "manual" });

		test("drives monitor-ci → fix-ci → monitor-ci → merge-pr → sync-repo", async ({
			page,
			server,
			sandbox,
		}) => {
			test.setTimeout(180_000);

			const app = new AppPage(page);
			await app.goto(server.baseUrl);
			await app.waitConnected();

			await createSpecification(app, {
				specification: "Add a dark mode toggle to the application settings.",
				repo: sandbox.targetRepo,
			});

			const card = new WorkflowCardPage(page);

			await waitForStep(card, "setup", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "specify", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "clarify", "waiting", { timeoutMs: 60_000 });

			await answerClarifyingQuestion(card, "Yes, it should support dark mode.", {
				expectQuestionContains: "Should the feature support dark mode?",
			});

			await waitForStep(card, "clarify", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "plan", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "tasks", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "implement", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "review", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "implement-review", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "commit-push-pr", "completed", { timeoutMs: 60_000 });

			await expect(card.prLink()).toBeVisible();
			await expect(card.prLink()).toHaveAttribute("href", /github\.com\/example\/repo\/pull\/42/);

			// Load-bearing: fix-ci must reach completed, proving the recovery
			// branch was taken. The second monitor-ci run reaching completed is
			// implied by merge-pr becoming mergeable below — a direct
			// `waitForStep("monitor-ci", "completed")` here would race the
			// first-pass completion broadcast and risk a no-op match.
			await waitForStep(card, "fix-ci", "completed", { timeoutMs: 60_000 });

			await mergePullRequest(card);

			await waitForStep(card, "merge-pr", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "sync-repo", "completed", { timeoutMs: 60_000 });
			await expect(card.statusBadge()).toHaveClass(/completed/, { timeout: 60_000 });
		});
	});

	test.describe("gives up cleanly when CI cannot be fixed", () => {
		test.use({
			scenarioName: "ci-failure-and-fix-terminal",
			autoMode: "manual",
			configOverrides: { limits: { ciFixMaxAttempts: 1 } },
		});

		test("lands in error with monitor-ci carrying the failure boundary", async ({
			page,
			server,
			sandbox,
		}) => {
			test.setTimeout(180_000);

			const app = new AppPage(page);
			await app.goto(server.baseUrl);
			await app.waitConnected();

			await createSpecification(app, {
				specification: "Add a dark mode toggle to the application settings.",
				repo: sandbox.targetRepo,
			});

			const card = new WorkflowCardPage(page);

			await waitForStep(card, "setup", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "specify", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "clarify", "waiting", { timeoutMs: 60_000 });

			await answerClarifyingQuestion(card, "Yes, it should support dark mode.", {
				expectQuestionContains: "Should the feature support dark mode?",
			});

			await waitForStep(card, "clarify", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "plan", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "tasks", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "implement", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "review", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "implement-review", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "commit-push-pr", "completed", { timeoutMs: 60_000 });

			// fix-ci runs once (completed) then the second monitor-ci pass
			// trips the budget guard and lands in error.
			await waitForStep(card, "fix-ci", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "monitor-ci", "error", { timeoutMs: 60_000 });

			// Failure boundary disambiguation: fix-ci reached completed, not
			// error — so the boundary is on monitor-ci, not fix-ci.
			await expect(card.stepIndicator("fix-ci")).toHaveClass(
				new RegExp(card.stepStateClass("completed")),
			);
			await expect(card.stepIndicator("merge-pr")).toHaveClass(
				new RegExp(card.stepStateClass("pending")),
			);
			await expect(card.stepIndicator("sync-repo")).toHaveClass(
				new RegExp(card.stepStateClass("pending")),
			);

			await expect(card.statusBadge()).toHaveClass(/error/, { timeout: 60_000 });
		});
	});
});
