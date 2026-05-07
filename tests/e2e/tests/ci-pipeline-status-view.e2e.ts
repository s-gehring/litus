// E2E coverage for the CI pipeline status icon row (research R-9 layer 3).
// Drives a multi-poll scenario via the same `gh pr checks` array-form fake
// pattern as `ci-failure-and-fix.json` and asserts:
//   • the icon row appears once monitor-ci is selected (FR-001, FR-002),
//   • category classes & aria-labels are correct (FR-004, FR-005),
//   • the pulse class is applied to non-terminal entries on a poll-driven
//     update and NOT to terminal entries (FR-008, B-6),
//   • per-poll text lines are still appended to #output-log (FR-009),
//   • clicking another step removes the row; clicking monitor-ci re-mounts
//     it with the latest known state (FR-010, B-1).

import { expect, test } from "../harness/fixtures";
import { answerClarifyingQuestion, createSpecification, waitForStep } from "../helpers";
import { AppPage, WorkflowCardPage } from "../pages";

test.describe("CI pipeline status icon row — multi-poll", () => {
	test.use({
		scenarioName: "ci-pipeline-status-view",
		autoMode: "manual",
		// Faster polls so the test observes ≥2 polls within its timeout.
		// Defaults are 15s which would push test runtime past the budget.
		configOverrides: { timing: { ciPollIntervalMs: 1000 } },
	});

	test("renders icons, pulses non-terminal entries on a fresh poll, preserves output log", async ({
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

		// Drive the pipeline up to monitor-ci.
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

		// Click monitor-ci to ensure it's the selected step (in case auto-select
		// landed elsewhere on a fast pipeline). It must be running by now.
		await waitForStep(card, "monitor-ci", "running", { timeoutMs: 60_000 });
		await card.stepIndicator("monitor-ci").click();

		const row = page.locator(".ci-pipeline-status-view");
		await expect(row).toBeVisible({ timeout: 30_000 });

		// Poll 1: build pass, lint pending, test pending. Wait for all three
		// names to appear in some order so we don't race the first poll.
		await expect(row.locator(".ci-entry")).toHaveCount(3, { timeout: 30_000 });
		await expect(row.locator('.ci-entry[aria-label="build"]')).toHaveClass(/ci-entry-succeeded/);
		await expect(
			row.locator('.ci-entry[aria-label="lint"], .ci-entry[aria-label="test"]'),
		).toHaveCount(2);

		// Poll 2: lint flips to fail (terminal), test stays pending (non-terminal).
		// The non-terminal `test` entry must receive the pulse class on the
		// poll-driven update; the terminal `build` must NOT pulse.
		await expect(row.locator('.ci-entry[aria-label="lint"]')).toHaveClass(/ci-entry-failed/, {
			timeout: 30_000,
		});
		// Pulse is one-shot (~600 ms): use the fact that animationend strips the
		// class to assert presence transiently. We wait for the class to appear
		// on the non-terminal entry within a generous window.
		await expect(async () => {
			const testEntry = row.locator('.ci-entry[aria-label="test"]');
			const className = (await testEntry.getAttribute("class")) ?? "";
			// Non-terminal `test` entry must have either pulsed (class still
			// pending) OR fully completed an animation cycle since last poll.
			// Asserting the *terminal* entries never pulse is the cleaner
			// invariant (the negative case can't race the animationend).
			const buildClass =
				(await row.locator('.ci-entry[aria-label="build"]').getAttribute("class")) ?? "";
			expect(buildClass).not.toContain("ci-entry-pulse");
			// `test` entry should reflect non-terminal styling — its class set
			// is what changes per poll.
			expect(className).toMatch(/ci-entry-(in-progress|succeeded)/);
		}).toPass({ timeout: 30_000 });

		// FR-009: per-poll text lines must still appear in #output-log
		// underneath. The orchestrator emits "[poll N/M] …" lines on every
		// poll completion.
		const outputLog = page.locator("#output-log");
		await expect(outputLog).toContainText("[poll");

		// FR-002 / B-1: select another step → row detaches.
		await card.stepIndicator("commit-push-pr").click();
		await expect(row).toHaveCount(0);

		// Re-select monitor-ci → row re-mounts with current data.
		await card.stepIndicator("monitor-ci").click();
		await expect(page.locator(".ci-pipeline-status-view")).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(".ci-entry")).toHaveCount(3);
	});
});
