import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../harness/fixtures";
import { createEpic } from "../helpers";
import { AppPage } from "../pages/app";
import { EpicTree } from "../pages/epic-tree";

/**
 * E2E coverage for the epic feedback UX rehome (Stories 1–4):
 *  - Provide Feedback button in #detail-actions, opens form at top
 *  - Form open/close, focus, scrollIntoView, hide-on-open, cancel discards
 *  - Feedback history sits in #epic-feedback-section under #user-input
 *  - Textarea styling matches the spec form (.answer-input)
 */
const EPIC_E2E_CONFIG_OVERRIDES = {
	prompts: {
		epicDecomposition:
			"Decompose this epic into self-contained specs and return a JSON code block. Epic: ${epicDescription}",
	},
	limits: { maxJsonRetries: 1 },
} as const;

function readEpicId(sandbox: { homeDir: string }): string {
	const epicsFile = join(sandbox.homeDir, ".litus/workflows/epics.json");
	const raw = readFileSync(epicsFile, "utf8");
	const list = JSON.parse(raw) as Array<{ epicId: string }>;
	if (!list[0]?.epicId) throw new Error("epics.json missing first epicId");
	return list[0].epicId;
}

test.describe("Epic feedback UX (Stories 1–4)", () => {
	test.use({
		scenarioName: "epic-feedback",
		autoMode: "manual",
		configOverrides: EPIC_E2E_CONFIG_OVERRIDES,
	});

	test("Story 2: Provide Feedback button opens form at top, focuses, hides button, cancel discards", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(60_000);

		const app = new AppPage(page);
		const tree = new EpicTree(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createEpic({
			page,
			description: "Add authentication to the application including login and logout.",
			repo: sandbox.targetRepo,
			start: false,
		});
		await expect(tree.allChildRows()).toHaveCount(2, { timeout: 15_000 });

		const provideBtn = page.locator('#detail-actions button:has-text("Provide Feedback")');
		await expect(provideBtn).toBeVisible({ timeout: 15_000 });

		// Open form: panel visible at top, textarea focused, button hidden.
		await provideBtn.click();
		const panel = page.locator("#epic-feedback-panel");
		const input = page.locator("#epic-feedback-input");
		await expect(panel).toBeVisible();
		await expect(input).toBeFocused();
		await expect(provideBtn).toHaveCount(0);

		// Cancel: form closes, draft cleared, button reappears.
		await input.fill("partial draft");
		await page.locator("#btn-cancel-epic-feedback").click();
		await expect(panel).toBeHidden();
		await expect(provideBtn).toBeVisible();
		await provideBtn.click();
		await expect(input).toHaveValue("");

		// Cancel a second time to leave the screen tidy for subsequent tests.
		await page.locator("#btn-cancel-epic-feedback").click();
	});

	test("Story 4 / US4: epic textarea matches spec textarea styling (.answer-input + var(--bg))", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(60_000);

		const app = new AppPage(page);
		const tree = new EpicTree(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createEpic({
			page,
			description: "Add authentication to the application including login and logout.",
			repo: sandbox.targetRepo,
			start: false,
		});
		await expect(tree.allChildRows()).toHaveCount(2, { timeout: 15_000 });

		await page.locator('#detail-actions button:has-text("Provide Feedback")').click();

		// `.answer-input` class is the parity contract — the spec textarea uses
		// it too. Confirms the bright-white bug is gone.
		const epicInput = page.locator("#epic-feedback-input");
		await expect(epicInput).toHaveClass(/answer-input/);
	});

	test("Story 3: feedback history is hidden when no entries exist (zero-history case)", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(60_000);

		const app = new AppPage(page);
		const tree = new EpicTree(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createEpic({
			page,
			description: "Add authentication to the application including login and logout.",
			repo: sandbox.targetRepo,
			start: false,
		});
		await expect(tree.allChildRows()).toHaveCount(2, { timeout: 15_000 });

		// Wait for epic persistence to land.
		const epicsFile = join(sandbox.homeDir, ".litus/workflows/epics.json");
		await expect.poll(() => existsSync(epicsFile), { timeout: 15_000 }).toBe(true);
		readEpicId(sandbox);

		const section = page.locator("#epic-feedback-section");
		// Either hidden or empty — both signal "no history block".
		await expect(section).toHaveClass(/hidden/);
	});

	test("Story 1 + 3: submitting feedback emits no epic-finished alert and renders entry between user-input and analysis notes (FR-001, FR-010)", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(90_000);

		const app = new AppPage(page);
		const tree = new EpicTree(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createEpic({
			page,
			description: "Add authentication to the application including login and logout.",
			repo: sandbox.targetRepo,
			start: false,
		});
		await expect(tree.allChildRows()).toHaveCount(2, { timeout: 15_000 });

		// Open the feedback form via the top-mounted button.
		const provideBtn = page.locator('#detail-actions button:has-text("Provide Feedback")');
		await expect(provideBtn).toBeVisible({ timeout: 15_000 });
		await provideBtn.click();

		const input = page.locator("#epic-feedback-input");
		await input.fill("Please refine the decomposition and split the auth spec further.");
		await page.locator("#btn-submit-epic-feedback").click();

		// FR-001 / SC-001: no `epic-finished` toast appears as a side-effect of
		// the abort cascade triggered by feedback submission. Wait long enough
		// to cover server roundtrip + abort flush.
		const toasts = page.locator("#alert-toast-container .alert-toast");
		const epicFinishedToast = toasts.filter({ hasText: "Epic finished" });
		await page.waitForTimeout(1_500);
		await expect(epicFinishedToast).toHaveCount(0);

		// FR-010: history entry renders inside #epic-feedback-section, and the
		// section appears between #user-input and the analysis/decomposition
		// summary block (#epic-analysis-notes when present, otherwise #spec-details).
		const section = page.locator("#epic-feedback-section");
		await expect(section.locator(".feedback-entry")).toHaveCount(1, { timeout: 15_000 });

		const order = await page.evaluate(() => {
			const userInput = document.getElementById("user-input");
			const fbSection = document.getElementById("epic-feedback-section");
			const analysis = document.getElementById("epic-analysis-notes");
			const specDetails = document.getElementById("spec-details");
			const tail = analysis ?? specDetails;
			if (!userInput || !fbSection || !tail) return { ok: false, reason: "missing nodes" };
			const userBeforeSection =
				userInput.compareDocumentPosition(fbSection) & Node.DOCUMENT_POSITION_FOLLOWING;
			const sectionBeforeTail =
				fbSection.compareDocumentPosition(tail) & Node.DOCUMENT_POSITION_FOLLOWING;
			return { ok: Boolean(userBeforeSection && sectionBeforeTail), reason: null };
		});
		expect(order.ok, order.reason ?? undefined).toBe(true);
	});
});
