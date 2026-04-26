import { expect, test } from "../harness/fixtures";
import { createEpic } from "../helpers/create-epic";
import { AppPage } from "../pages/app";
import { EpicTree } from "../pages/epic-tree";

// Same rationale as `epic-lifecycle.e2e.ts`: keep the analyzer prompt to a
// single line so the Windows .cmd shim does not truncate `-p` at the first
// newline. `maxJsonRetries: 1` fails fast on JSON parse errors.
const EPIC_E2E_CONFIG_OVERRIDES = {
	prompts: {
		epicDecomposition:
			"Decompose this epic into self-contained specs and return a JSON code block. Epic: ${epicDescription}",
	},
	limits: {
		maxJsonRetries: 1,
	},
} as const;

test.describe("Epic start-first-level button", () => {
	test.use({
		scenarioName: "epic-start-first-level",
		autoMode: "manual",
		configOverrides: EPIC_E2E_CONFIG_OVERRIDES,
	});

	test("clicking 'Start N specs' starts only first-level specs and disappears", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(120_000);

		const app = new AppPage(page);
		const tree = new EpicTree(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		// Create the epic WITHOUT auto-starting so first-level specs land in
		// `idle` and the "Start N specs" button has work to do.
		await createEpic({
			page,
			description: "Bulk start fixture epic with two independent specs and one dependent.",
			repo: sandbox.targetRepo,
			start: false,
		});

		await expect(tree.allChildRows()).toHaveCount(3, { timeout: 15_000 });
		const aRow = tree.childRowByTitle("Spec A");
		const bRow = tree.childRowByTitle("Spec B");
		const cRow = tree.childRowByTitle("Spec C");
		await expect(aRow).toBeVisible();
		await expect(bRow).toBeVisible();
		await expect(cRow).toBeVisible();

		// All three specs should land idle after creation (autoStart = false).
		await expect(aRow.locator(".card-status")).toHaveClass(/card-status-idle/);
		await expect(bRow.locator(".card-status")).toHaveClass(/card-status-idle/);

		// Two first-level idle specs ⇒ the button label is "Start 2 specs".
		const startButton = page.locator("#detail-actions [data-testid='action-start-children']");
		await expect(startButton).toBeVisible();

		await startButton.click();

		// First-level specs (A and B) leave idle and end up in error after
		// their scripted CLI failure.
		await expect(aRow.locator(".card-status")).not.toHaveClass(/card-status-idle/, {
			timeout: 30_000,
		});
		await expect(bRow.locator(".card-status")).not.toHaveClass(/card-status-idle/, {
			timeout: 30_000,
		});

		// Spec C depends on A and is therefore parked: it stays idle or has a
		// waiting-for-dependencies badge; either way it MUST NOT have left
		// the dependency-blocked + idle bucket and started its own pipeline.
		// We simply assert it is NOT in `error`/`running`/`completed` shortly
		// after the click — those would mean it was incorrectly started.
		await expect(cRow.locator(".card-status")).not.toHaveClass(
			/card-status-running|card-status-error|card-status-completed/,
			{ timeout: 5_000 },
		);

		// Once no idle first-level specs remain, the button must disappear
		// (FR-004 / FR-005).
		await expect(startButton).toHaveCount(0, { timeout: 15_000 });
		await expect(page.locator("#detail-actions [data-testid='action-start-children']")).toHaveCount(
			0,
		);
	});

	test("'Start N specs' is visible after a page reload and drives the full flow", async ({
		page,
		server,
		sandbox,
	}) => {
		// Regression for the bug fixed in 1855b53: `buildEpicActions` early-returned
		// when `state.getEpics()` had no entry for the epicId. After a page reload
		// `workflow:list` and `epic:list` both arrive on WS connect; under the
		// pre-fix code the action bar (and the Start button) could be hidden
		// during the brief window before `epic:list` populated the epic record.
		// The fix makes the button independent of the epic record. We exercise
		// the full flow starting from a reloaded page so a regression here
		// would surface as a missing button after refresh.
		test.setTimeout(120_000);

		const app = new AppPage(page);
		const tree = new EpicTree(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createEpic({
			page,
			description: "Bulk start fixture epic with two independent specs and one dependent.",
			repo: sandbox.targetRepo,
			start: false,
		});

		await expect(tree.allChildRows()).toHaveCount(3, { timeout: 15_000 });

		// Reload the page — forces the client to re-issue WS messages from
		// scratch and re-render the epic detail with state freshly hydrated.
		await page.reload();
		await app.waitConnected();

		await expect(tree.allChildRows()).toHaveCount(3, { timeout: 15_000 });
		const aRow = tree.childRowByTitle("Spec A");
		const bRow = tree.childRowByTitle("Spec B");

		// The Start button MUST be visible after reload — this is the assertion
		// that would have failed under the pre-fix code path.
		const startButton = page.locator("#detail-actions [data-testid='action-start-children']");
		await expect(startButton).toBeVisible({ timeout: 15_000 });

		// Drive the full flow from the reloaded page to confirm clicking still
		// starts the first-level specs end-to-end.
		await startButton.click();
		await expect(aRow.locator(".card-status")).not.toHaveClass(/card-status-idle/, {
			timeout: 30_000,
		});
		await expect(bRow.locator(".card-status")).not.toHaveClass(/card-status-idle/, {
			timeout: 30_000,
		});
		await expect(startButton).toHaveCount(0, { timeout: 15_000 });
	});

	test("Abort-all on the epic fans out to every abortable child", async ({
		page,
		server,
		sandbox,
	}) => {
		// E2E contract for the epic batch fan-out: clicking "Abort all" sends
		// epic:abort-all → server fans out abort to every abortable child →
		// each child reaches the aborted/error terminal state. The unit
		// tests pin the per-child predicates; this test pins the click →
		// fan-out → child-state-transition path end-to-end.
		test.setTimeout(120_000);

		const app = new AppPage(page);
		const tree = new EpicTree(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createEpic({
			page,
			description: "Bulk start fixture epic with two independent specs and one dependent.",
			repo: sandbox.targetRepo,
			start: false,
		});

		await expect(tree.allChildRows()).toHaveCount(3, { timeout: 15_000 });
		const aRow = tree.childRowByTitle("Spec A");
		const bRow = tree.childRowByTitle("Spec B");

		// Kick off A and B; both will land in `error` after their scripted
		// failure. `error` is one of the abortable predicates per
		// `buildEpicActions`, so the Abort-all button must surface.
		const startButton = page.locator("#detail-actions [data-testid='action-start-children']");
		await startButton.click();

		await expect(aRow.locator(".card-status")).toHaveClass(/card-status-error/, {
			timeout: 30_000,
		});
		await expect(bRow.locator(".card-status")).toHaveClass(/card-status-error/, {
			timeout: 30_000,
		});

		const abortAll = page.locator("#detail-actions [data-testid='action-abort-all']");
		await expect(abortAll).toBeVisible({ timeout: 10_000 });

		// Native dialog spy — Abort-all must surface the in-app modal, never
		// a native confirm().
		let nativeDialogSeen = false;
		page.on("dialog", () => {
			nativeDialogSeen = true;
		});

		await abortAll.click();
		const modal = page.locator(".confirm-modal");
		await expect(modal).toBeVisible({ timeout: 5_000 });
		await expect(modal.locator(".confirm-modal-title")).toHaveText(
			"Abort every non-terminal child?",
		);

		// Confirm — both errored children must transition to aborted.
		await modal.locator(".btn-primary").click();
		await expect(modal).toHaveCount(0, { timeout: 5_000 });

		await expect(aRow.locator(".card-status")).toHaveClass(/card-status-aborted/, {
			timeout: 30_000,
		});
		await expect(bRow.locator(".card-status")).toHaveClass(/card-status-aborted/, {
			timeout: 30_000,
		});

		expect(nativeDialogSeen).toBe(false);
	});
});
