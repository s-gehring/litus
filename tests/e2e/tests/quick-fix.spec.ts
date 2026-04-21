import { expect, test } from "../harness/fixtures";
import { mergePullRequest, startQuickFix, waitForStep } from "../helpers";
import { AppPage, WorkflowCardPage } from "../pages";

test.use({ scenarioName: "quick-fix-happy-path", autoMode: "manual" });

test("quick-fix happy path: description through merged PR", async ({ page, server, sandbox }) => {
	test.setTimeout(180_000);

	const app = new AppPage(page);
	await app.goto(server.baseUrl);
	await app.waitConnected();

	await startQuickFix(app, {
		description: "Fix typo in the greeting helper.",
		repo: sandbox.targetRepo,
	});

	const card = new WorkflowCardPage(page);

	// Quick-fix kind pill should render next to the status badge (only shown
	// for quick-fix workflows, per workflow-window.ts).
	await expect(page.locator(".workflow-kind-pill.kind-quick-fix")).toBeVisible({
		timeout: 30_000,
	});

	await waitForStep(card, "setup", "completed", { timeoutMs: 60_000 });
	await waitForStep(card, "fix-implement", "completed", { timeoutMs: 60_000 });
	await waitForStep(card, "commit-push-pr", "completed", { timeoutMs: 60_000 });
	await waitForStep(card, "monitor-ci", "completed", { timeoutMs: 60_000 });

	await expect(card.prLink()).toBeVisible();
	await expect(card.prLink()).toHaveAttribute("href", /github\.com\/example\/repo\/pull\/77/);

	await mergePullRequest(card);

	await waitForStep(card, "merge-pr", "completed", { timeoutMs: 60_000 });
	await waitForStep(card, "sync-repo", "completed", { timeoutMs: 60_000 });
	await expect(card.statusBadge()).toHaveClass(/completed/, { timeout: 60_000 });

	// Spec-kit-only steps must remain absent from the rendered pipeline for a
	// quick-fix workflow (the UI derives the step list from workflowKind via
	// getStepDefinitionsForKind in src/types.ts).
	await expect(card.stepIndicator("specify")).toHaveCount(0);
	await expect(card.stepIndicator("plan")).toHaveCount(0);
	await expect(card.stepIndicator("implement")).toHaveCount(0);
	await expect(card.stepIndicator("review")).toHaveCount(0);
});
