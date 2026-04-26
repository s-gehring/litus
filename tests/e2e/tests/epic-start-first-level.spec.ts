import { expect, test } from "../harness/fixtures";
import { createEpic } from "../helpers/create-epic";
import { AppPage } from "../pages/app";
import { EpicTree } from "../pages/epic-tree";

// Same rationale as `epic-lifecycle.spec.ts`: keep the analyzer prompt to a
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
		const startButton = page.locator("#detail-actions [data-testid='action-start-2-specs']");
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
		await expect(page.locator("#detail-actions [data-testid^='action-start-']")).toHaveCount(0);
	});
});
