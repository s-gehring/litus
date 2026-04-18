import { expect, test } from "../harness/fixtures";
import {
	answerClarifyingQuestion,
	createSpecification,
	mergePullRequest,
	waitForStep,
} from "../helpers";
import { AppPage, WorkflowCardPage } from "../pages";

test.use({ scenarioName: "happy-path", autoMode: "manual" });

test("happy-path: spec creation through merged PR", async ({ page, server, sandbox }) => {
	test.setTimeout(180_000);

	const app = new AppPage(page);
	await app.goto(server.baseUrl);
	await app.waitConnected();

	await createSpecification(app, {
		specification: "Add a dark mode toggle to the application settings.",
		repo: sandbox.targetRepo,
	});

	const card = new WorkflowCardPage(page);

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
	await waitForStep(card, "monitor-ci", "completed", { timeoutMs: 60_000 });

	await expect(card.prLink()).toBeVisible();
	await expect(card.prLink()).toHaveAttribute("href", /github\.com\/example\/repo\/pull\/42/);

	await mergePullRequest(card);

	await waitForStep(card, "merge-pr", "completed", { timeoutMs: 60_000 });
	await waitForStep(card, "sync-repo", "completed", { timeoutMs: 60_000 });
	await expect(card.statusBadge()).toHaveClass(/completed/, { timeout: 60_000 });
});
