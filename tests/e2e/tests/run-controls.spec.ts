import { expect, test } from "../harness/fixtures";
import {
	abortRun,
	createSpecification,
	pauseRun,
	resumeRun,
	setAutomationMode,
	waitForStep,
} from "../helpers";
import { AppPage, WorkflowCardPage } from "../pages";

test.describe("US1: run-control surface", () => {
	test.use({ scenarioName: "run-controls" });

	test.describe("manual mode", () => {
		test.use({ autoMode: "manual" });

		test("pause surfaces Resume and resume returns to running", async ({
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

			// `specify` has a 1.5s delayMs in the scenario so we can catch a
			// running state and click Pause before it finishes.
			await waitForStep(card, "specify", "running", { timeoutMs: 30_000 });
			await pauseRun(card);

			// Pause is cooperative: the step completes at its safe boundary and
			// the workflow transitions to `paused`, surfacing a Resume action.
			await expect(card.resumeAction()).toBeVisible({ timeout: 30_000 });
			await expect(card.pauseAction()).toHaveCount(0);
			await expect(card.statusBadge()).toHaveClass(/paused/, { timeout: 10_000 });

			await resumeRun(card);

			// Resume returns the workflow to a running (or immediately
			// waiting-for-input at clarify) state, proving the control cycle
			// round-trips — the exact step reached depends on how fast the
			// resumed step completes vs. when we sample.
			await expect(card.statusBadge()).not.toHaveClass(/paused/, { timeout: 30_000 });
		});

		test("abort from waiting_for_input cancels the workflow", async ({ page, server, sandbox }) => {
			test.setTimeout(120_000);
			const app = new AppPage(page);
			await app.goto(server.baseUrl);
			await app.waitConnected();

			await createSpecification(app, {
				specification: "Add a dark mode toggle to the application settings.",
				repo: sandbox.targetRepo,
			});

			const card = new WorkflowCardPage(page);
			await waitForStep(card, "clarify", "waiting", { timeoutMs: 60_000 });

			await abortRun(card);

			// Abort terminates the workflow — status badge reflects a terminal
			// state (`cancelled`) and the Pause/Resume controls go away.
			await expect(card.statusBadge()).toHaveClass(/cancelled|error/, { timeout: 30_000 });
			await expect(card.pauseAction()).toHaveCount(0);
			await expect(card.resumeAction()).toHaveCount(0);
		});
	});

	test.describe("full-auto mode", () => {
		test.use({ autoMode: "full-auto" });

		test("merge-pr auto-completes without operator confirmation", async ({
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

			// Full Auto: pipeline runs end-to-end with no operator interaction at
			// merge-pr. Unlike manual/normal mode, no Resume/Merge action surfaces
			// between commit-push-pr and merge-pr.
			await waitForStep(card, "commit-push-pr", "completed", { timeoutMs: 120_000 });
			await waitForStep(card, "monitor-ci", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "merge-pr", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "sync-repo", "completed", { timeoutMs: 60_000 });
			await expect(card.statusBadge()).toHaveClass(/completed/, { timeout: 30_000 });
		});
	});

	test.describe("automation-mode toggle", () => {
		test("cycles Manual → Normal → Full Auto and back", async ({ page, server }) => {
			test.setTimeout(60_000);
			const app = new AppPage(page);
			await app.goto(server.baseUrl);
			await app.waitConnected();

			const card = new WorkflowCardPage(page);

			await setAutomationMode(card, "normal");
			await expect(card.autoModeToggle()).toHaveClass(/mode-normal/);

			await setAutomationMode(card, "full-auto");
			await expect(card.autoModeToggle()).toHaveClass(/mode-full-auto/);

			await setAutomationMode(card, "manual");
			await expect(card.autoModeToggle()).toHaveClass(/mode-manual/);
		});
	});
});
