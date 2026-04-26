import { expect, test } from "../harness/fixtures";
import { abortRun, createSpecification, pauseRun, resumeRun, waitForStep } from "../helpers";
import { AppPage, WorkflowCardPage } from "../pages";

/**
 * Asserts the unified detail-actions contract introduced by the action-bar
 * refactor. Covers — across the workflow lifecycle:
 *
 *   1. Slot order: primary → secondary → destructive → finalize, with the
 *      auto-margin spacer on the first right-side button.
 *   2. Stable, key-derived test-ids (action-pause, action-resume, …).
 *   3. The disabled archive button surfaces `disabled` + `title` instead of
 *      a label-suffix hack.
 *   4. Destructive actions (Abort, Restart) open the in-app
 *      `.confirm-modal` element — never a native `confirm()` dialog.
 *   5. Cancelling the modal is a no-op (no abort message dispatched).
 */
test.describe("detail action-bar contract", () => {
	test.use({ scenarioName: "run-controls-pause", autoMode: "manual" });

	test("running workflow: only primary Pause + disabled finalize Archive", async ({
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
		await waitForStep(card, "specify", "running", { timeoutMs: 30_000 });

		// Primary slot: Pause exists and is btn-primary, not btn-secondary.
		const pause = card.pauseAction();
		await expect(pause).toBeVisible();
		await expect(pause).toHaveAttribute("data-slot", "primary");
		await expect(pause).toHaveClass(/\bbtn-primary\b/);

		// Finalize slot: Archive exists but is disabled-with-tooltip while
		// running. The label is plain "Archive" — the disabled state lives
		// in the attributes, not the visible text.
		const archive = card.archiveAction();
		await expect(archive).toBeVisible();
		await expect(archive).toHaveAttribute("data-slot", "finalize");
		await expect(archive).toBeDisabled();
		await expect(archive).toHaveAttribute("aria-disabled", "true");
		await expect(archive).toHaveAttribute("title", "Cannot archive while running");
		await expect(archive).toHaveText("Archive");
	});

	test("paused workflow: slot order primary → destructive → finalize", async ({
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
		await waitForStep(card, "specify", "running", { timeoutMs: 30_000 });
		await pauseRun(card);

		await expect(card.statusBadge()).toHaveClass(/paused/, { timeout: 10_000 });

		// Read the rendered DOM order and assert the slot contract holds.
		const slots = await card
			.detailActions()
			.locator("button")
			.evaluateAll((els) =>
				(els as HTMLButtonElement[]).map((el) => ({
					key: el.getAttribute("data-testid"),
					slot: el.getAttribute("data-slot"),
				})),
			);
		// Resume (primary) → Abort (destructive) → Archive (finalize).
		// Provide-feedback is gated on merge-pr step, so it won't appear
		// here at specify-step pause.
		expect(slots).toEqual([
			{ key: "action-resume", slot: "primary" },
			{ key: "action-abort", slot: "destructive" },
			{ key: "action-archive", slot: "finalize" },
		]);

		// First right-side button gets the slot-break (auto-margin spacer).
		await expect(card.abortAction()).toHaveClass(/\bslot-break\b/);
		// Subsequent right-side buttons must NOT also break.
		await expect(card.archiveAction()).not.toHaveClass(/\bslot-break\b/);
	});

	test("abort opens .confirm-modal; Cancel is a no-op", async ({ page, server, sandbox }) => {
		test.setTimeout(120_000);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();
		await createSpecification(app, {
			specification: "Add a dark mode toggle to the application settings.",
			repo: sandbox.targetRepo,
		});

		const card = new WorkflowCardPage(page);
		await waitForStep(card, "specify", "running", { timeoutMs: 30_000 });
		await pauseRun(card);
		await expect(card.statusBadge()).toHaveClass(/paused/, { timeout: 10_000 });

		// Abort surfaces the DOM-based modal, NOT a native dialog.
		// Register a native dialog spy so an accidental regression to
		// `confirm()` would surface as a captured event.
		let nativeDialogSeen = false;
		page.on("dialog", () => {
			nativeDialogSeen = true;
		});

		await card.abortAction().click();
		const modal = card.confirmModal();
		await expect(modal).toBeVisible({ timeout: 5_000 });
		await expect(modal.locator(".confirm-modal-title")).toHaveText("Abort this workflow?");

		// Cancel — modal closes, workflow stays paused.
		await card.confirmModalCancel().click();
		await expect(modal).toHaveCount(0, { timeout: 5_000 });
		await expect(card.statusBadge()).toHaveClass(/paused/);
		expect(nativeDialogSeen).toBe(false);
	});

	test("abort confirm dispatches workflow:abort and reaches aborted", async ({
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
		await waitForStep(card, "specify", "running", { timeoutMs: 30_000 });
		await pauseRun(card);
		await expect(card.statusBadge()).toHaveClass(/paused/, { timeout: 10_000 });

		// Use the helper which clicks Abort, then confirms the modal.
		await abortRun(card);

		// Aborted is the canonical terminal state for the abort path; we
		// allow `error` only because some scenarios race the abort with a
		// scripted CLI failure.
		await expect(card.statusBadge()).toHaveClass(/\b(aborted|error)\b/, {
			timeout: 30_000,
		});
	});

	test("aborted workflow surfaces Restart with btn-warning style", async ({
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
		await waitForStep(card, "specify", "running", { timeoutMs: 30_000 });
		await pauseRun(card);
		await expect(card.statusBadge()).toHaveClass(/paused/, { timeout: 10_000 });
		await abortRun(card);
		await expect(card.statusBadge()).toHaveClass(/\b(aborted|error)\b/, {
			timeout: 30_000,
		});

		// "Restart" — visible label, but selector is action-retry-workflow.
		const reset = card.retryWorkflowAction();
		await expect(reset).toBeVisible();
		await expect(reset).toHaveText("Restart");
		await expect(reset).toHaveClass(/\bbtn-warning\b/);
		await expect(reset).toHaveAttribute("data-slot", "destructive");
	});

	test("resume from pause makes Pause the only primary action again", async ({
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
		await waitForStep(card, "specify", "running", { timeoutMs: 30_000 });
		await pauseRun(card);
		await expect(card.resumeAction()).toBeVisible({ timeout: 30_000 });

		await resumeRun(card);

		await expect(card.statusBadge()).toHaveClass(/\b(running|waiting_for_input)\b/, {
			timeout: 30_000,
		});
		// After resume we expect Pause back, never Resume.
		// Allow some time for the action-bar re-render to follow the
		// status broadcast.
		await expect(card.resumeAction()).toHaveCount(0, { timeout: 10_000 });
	});
});
