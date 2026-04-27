import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

		// Feedback container + panel textarea should be present and eligible.
		await expect(page.locator("#epic-feedback-ui")).toBeVisible({ timeout: 15_000 });
		await expect(page.locator(".epic-feedback-panel textarea.epic-feedback-input")).toBeVisible();
		// Submit button starts disabled (empty textarea).
		await expect(page.locator(".epic-feedback-panel button.btn-primary")).toBeDisabled();
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

	test("rejects raw epic:feedback with reasonCode=validation when text exceeds 10 000 chars", async ({
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

		const tooLong = "x".repeat(10_001);
		const result = await submitEpicFeedbackRaw(page, epicId, tooLong);
		expect(result.type).toBe("epic:feedback:rejected");
		expect(result.reasonCode).toBe("validation");
	});
});
