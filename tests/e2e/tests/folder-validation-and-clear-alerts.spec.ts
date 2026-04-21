import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../harness/fixtures";
import { triggerFailure } from "../helpers";
import { AlertsPage, AppPage, EpicFormPage, QuickFixFormPage, SpecFormPage } from "../pages";

// ── Folder validation: green checkmark + git-repo check ─────────

test.describe("spec-modal folder validation", () => {
	test.use({ scenarioName: "peripheral-alerts", autoMode: "manual" });

	test("valid git repo shows green checkmark; non-git folder shows inline error", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(60_000);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const form = new SpecFormPage(page);
		await app.newSpecButton().click();
		await expect(form.modal()).toBeVisible();

		// The sandbox's `targetRepo` is a real git repo. After blur, the
		// validator should probe /api/folder-exists, decide the folder is
		// usable, and the success indicator ("✓ Valid git repository") should
		// be visible while the inline error stays hidden.
		await form.repoInput().fill(sandbox.targetRepo);
		await form.repoInput().blur();
		await expect(form.fieldSuccess()).toBeVisible({ timeout: 10_000 });
		await expect(form.fieldSuccess()).toContainText("Valid git repository");
		await expect(form.fieldError()).toBeHidden();

		// A non-git folder inside $HOME should now flip the affordance: the
		// success check hides, the inline error surfaces the new
		// "not_a_git_repo" reason.
		const nonGit = join(sandbox.homeDir, "not-a-repo");
		await mkdir(nonGit, { recursive: true });
		await form.repoInput().fill(nonGit);
		await form.repoInput().blur();
		await expect(form.fieldError()).toBeVisible({ timeout: 10_000 });
		await expect(form.fieldError()).toContainText(/git repository/i);
		await expect(form.fieldSuccess()).toBeHidden();

		// A non-existent folder still yields the pre-existing
		// "Folder does not exist." error — regression guard so the new
		// not_a_git_repo branch didn't accidentally shadow the not_found one.
		await form.repoInput().fill(join(sandbox.homeDir, "does-not-exist-xyz-42"));
		await form.repoInput().blur();
		await expect(form.fieldError()).toBeVisible({ timeout: 10_000 });
		await expect(form.fieldError()).toContainText(/does not exist/i);
		await expect(form.fieldSuccess()).toBeHidden();
	});
});

// ── Folder validation: hung probe must not silently abort submit ─

test.describe("spec-modal folder validation: hung probe", () => {
	test.use({ scenarioName: "peripheral-alerts", autoMode: "manual" });

	test("clicking Start while a blur probe is hung surfaces a visible error instead of silently aborting", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(60_000);

		// Hang every /api/folder-exists call past the client-side 5s probe
		// timeout. The fix under test: probeFolder aborts via AbortController,
		// submitCheck awaits the pending blur probe, and surfaces the inline
		// "Could not validate folder" error rather than swallowing the click.
		await page.route("**/api/folder-exists*", async () => {
			await new Promise((r) => setTimeout(r, 20_000));
		});

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const form = new SpecFormPage(page);
		await app.newSpecButton().click();
		await expect(form.modal()).toBeVisible();

		// Kick off a blur probe that will hang on the stubbed endpoint.
		await form.repoInput().fill(sandbox.targetRepo);
		await form.repoInput().blur();

		// Fill spec so the only thing standing between click and start is the
		// folder probe, then click Start while the blur probe is in flight.
		await form.specificationInput().fill("Hung-probe regression guard");
		await form.submitButton().click();

		// Within the 5s probe timeout (+ slack), the inline error must surface
		// visibly. Without the fix, submitCheck would resolve to false silently
		// and the user would see nothing.
		await expect(form.fieldError()).toBeVisible({ timeout: 15_000 });
		await expect(form.fieldError()).toContainText(/try again/i);
		await expect(form.fieldSuccess()).toBeHidden();
		// Modal stays open — no silent dismissal.
		await expect(form.modal()).toBeVisible();
	});
});

// ── Folder validation: quick-fix modal ──────────────────────────

test.describe("quick-fix-modal folder validation", () => {
	test.use({ scenarioName: "peripheral-alerts", autoMode: "manual" });

	test("valid git repo shows green checkmark; non-git folder shows inline error", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(60_000);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const form = new QuickFixFormPage(page);
		await app.quickFixButton().click();
		await expect(form.modal()).toBeVisible();

		await form.repoInput().fill(sandbox.targetRepo);
		await form.repoInput().blur();
		await expect(form.fieldSuccess()).toBeVisible({ timeout: 10_000 });
		await expect(form.fieldSuccess()).toContainText("Valid git repository");
		await expect(form.fieldError()).toBeHidden();

		const nonGit = join(sandbox.homeDir, "qf-not-a-repo");
		await mkdir(nonGit, { recursive: true });
		await form.repoInput().fill(nonGit);
		await form.repoInput().blur();
		await expect(form.fieldError()).toBeVisible({ timeout: 10_000 });
		await expect(form.fieldError()).toContainText(/git repository/i);
		await expect(form.fieldSuccess()).toBeHidden();

		await form.repoInput().fill(join(sandbox.homeDir, "qf-does-not-exist-xyz-42"));
		await form.repoInput().blur();
		await expect(form.fieldError()).toBeVisible({ timeout: 10_000 });
		await expect(form.fieldError()).toContainText(/does not exist/i);
		await expect(form.fieldSuccess()).toBeHidden();
	});
});

// ── Folder validation: epic modal ───────────────────────────────

test.describe("epic-modal folder validation", () => {
	test.use({ scenarioName: "peripheral-alerts", autoMode: "manual" });

	test("valid git repo shows green checkmark; non-git folder shows inline error", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(60_000);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const form = new EpicFormPage(page);
		await app.newEpicButton().click();
		await expect(form.modal()).toBeVisible();

		await form.repoInput().fill(sandbox.targetRepo);
		await form.repoInput().blur();
		await expect(form.fieldSuccess()).toBeVisible({ timeout: 10_000 });
		await expect(form.fieldSuccess()).toContainText("Valid git repository");
		await expect(form.fieldError()).toBeHidden();

		const nonGit = join(sandbox.homeDir, "epic-not-a-repo");
		await mkdir(nonGit, { recursive: true });
		await form.repoInput().fill(nonGit);
		await form.repoInput().blur();
		await expect(form.fieldError()).toBeVisible({ timeout: 10_000 });
		await expect(form.fieldError()).toContainText(/git repository/i);
		await expect(form.fieldSuccess()).toBeHidden();

		await form.repoInput().fill(join(sandbox.homeDir, "epic-does-not-exist-xyz-42"));
		await form.repoInput().blur();
		await expect(form.fieldError()).toBeVisible({ timeout: 10_000 });
		await expect(form.fieldError()).toContainText(/does not exist/i);
		await expect(form.fieldSuccess()).toBeHidden();
	});
});

// ── Alerts: Clear all ───────────────────────────────────────────

test.describe("alerts clear-all", () => {
	test.use({ scenarioName: "peripheral-alerts", autoMode: "manual" });

	test("Clear all button removes every alert and persists across reload", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(120_000);

		const app = new AppPage(page);
		const alerts = new AlertsPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		// Seed two failure alerts so "clear all" has real work to do — a
		// one-alert case would also be cleared by dismissing the single row.
		await triggerFailure(app, alerts, {
			specification: "Clear-all scenario workflow one",
			repo: sandbox.targetRepo,
		});
		await triggerFailure(app, alerts, {
			specification: "Clear-all scenario workflow two",
			repo: sandbox.targetRepo,
		});
		await expect
			.poll(async () => alerts.currentBellCount(), { timeout: 30_000 })
			.toBeGreaterThanOrEqual(2);

		await alerts.openList();
		await expect(alerts.listRows()).toHaveCount(2);
		await expect(alerts.clearAllButton()).toBeVisible();

		await alerts.clearAllButton().click();
		// Panel stays open; rows collapse to the empty-state placeholder.
		await expect(alerts.listPanel().locator(".alert-list-empty")).toBeVisible({ timeout: 5_000 });
		await expect(alerts.listRows()).toHaveCount(0);
		// The header button itself disappears when the queue is empty — it
		// only renders alongside rows.
		await expect(alerts.clearAllButton()).toHaveCount(0);
		await expect(alerts.bellCount()).toBeHidden();
		await alerts.closeList();

		// Persistence: clearing is server-side, so a reload must not resurrect
		// the alerts. The pre-existing dismiss flow in peripheral-coverage.spec
		// already gates one-id persistence; this asserts the bulk-clear path.
		await page.reload();
		await app.waitConnected();
		await expect(alerts.bellCount()).toBeHidden();
		await alerts.openList();
		await expect(alerts.listRows()).toHaveCount(0);
	});
});
