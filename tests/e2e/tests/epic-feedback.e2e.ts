import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EPIC_FEEDBACK_MAX_LENGTH } from "../../../src/types";
import { expect, test } from "../harness/fixtures";
import { createEpic } from "../helpers";
import { submitEpicFeedbackRaw } from "../helpers/submit-epic-feedback";
import { AppPage } from "../pages/app";
import { EpicTree } from "../pages/epic-tree";

/**
 * Shared config overrides — same reasoning as epic-lifecycle.spec.ts: the
 * production `prompts.epicDecomposition` template is multi-line and gets
 * truncated by the Windows cmd.exe wrapper at the first newline, so the fake
 * claude would miss `--output-format stream-json`. Collapse to a single line
 * while keeping `${epicDescription}` interpolation intact.
 */
const EPIC_E2E_CONFIG_OVERRIDES = {
	prompts: {
		epicDecomposition:
			"Decompose this epic into self-contained specs and return a JSON code block. Epic: ${epicDescription}",
	},
	limits: {
		maxJsonRetries: 1,
	},
} as const;

function readEpicId(sandbox: { homeDir: string }): string {
	const epicsFile = join(sandbox.homeDir, ".litus/workflows/epics.json");
	const raw = readFileSync(epicsFile, "utf8");
	const list = JSON.parse(raw) as Array<{ epicId: string }>;
	if (!list[0]?.epicId) throw new Error("epics.json missing first epicId");
	return list[0].epicId;
}

test.describe("Epic decomposition feedback", () => {
	test.use({
		scenarioName: "epic-feedback",
		autoMode: "manual",
		configOverrides: EPIC_E2E_CONFIG_OVERRIDES,
	});

	test("renders the Give-Feedback panel on a completed decomposition", async ({
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

		// Wait for decomposition to land.
		await expect(tree.allChildRows()).toHaveCount(2, { timeout: 15_000 });

		// "Provide Feedback" button is present in detail-actions for an
		// eligible epic. Click to open the form at the top of the screen.
		const provideFeedbackBtn = page.locator('#detail-actions button:has-text("Provide Feedback")');
		await expect(provideFeedbackBtn).toBeVisible({ timeout: 15_000 });
		await provideFeedbackBtn.click();

		// Form panel + textarea visible; submit button disabled on empty input.
		await expect(page.locator("#epic-feedback-panel")).toBeVisible();
		await expect(page.locator("#epic-feedback-input")).toBeVisible();
		await expect(page.locator("#btn-submit-epic-feedback")).toBeDisabled();
	});

	test("rejects raw epic:feedback with reasonCode=validation on unknown epicId", async ({
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

		const result = await submitEpicFeedbackRaw(page, "does-not-exist", "Please split spec 2.");
		expect(result.type).toBe("epic:feedback:rejected");
		expect(result.reasonCode).toBe("validation");
	});

	test("rejects raw epic:feedback with reasonCode=validation on empty/whitespace text", async ({
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

		const epicsFile = join(sandbox.homeDir, ".litus/workflows/epics.json");
		await expect.poll(() => existsSync(epicsFile), { timeout: 15_000 }).toBe(true);
		const epicId = readEpicId(sandbox);

		const empty = await submitEpicFeedbackRaw(page, epicId, "");
		expect(empty.type).toBe("epic:feedback:rejected");
		expect(empty.reasonCode).toBe("validation");

		const whitespace = await submitEpicFeedbackRaw(page, epicId, "   \t\n  ");
		expect(whitespace.type).toBe("epic:feedback:rejected");
		expect(whitespace.reasonCode).toBe("validation");
	});

	test("rejects raw epic:feedback with reasonCode=validation when text exceeds the max length", async ({
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
		const epicId = readEpicId(sandbox);

		const tooLong = "x".repeat(EPIC_FEEDBACK_MAX_LENGTH + 1);
		const result = await submitEpicFeedbackRaw(page, epicId, tooLong);
		expect(result.type).toBe("epic:feedback:rejected");
		expect(result.reasonCode).toBe("validation");
	});
});
