import { expect, test } from "../harness/fixtures";
import { clonedRepo } from "../helpers/cloned-repo";
import { ServerMessageObserver } from "../helpers/server-messages";
import { AppPage } from "../pages";
import { SpecFormPage } from "../pages/spec-form";

test.use({ scenarioName: "repo-clone", autoMode: "manual" });

test.describe("repo-clone", () => {
	test("success path: clones, shows progress, persists across reload", async ({ page, server }) => {
		const observer = new ServerMessageObserver(page);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		// FR-008: assert the in-modal `.modal-clone-status` progress indicator
		// is rendered (non-empty) BEFORE terminal; the scripted `delayMs` on
		// the success clone response keeps the window wide enough to observe.
		const result = await clonedRepo(app, observer, {
			repo: "https://github.com/litus/succeeds.git",
			specification: "does not matter — clone flow only",
			assertProgressVisible: true,
		});

		// Server-side progress event complements the DOM assertion — together
		// they cover both surfaces of FR-008.
		expect(observer.hasReceived((m) => m.type === "repo:clone-progress")).toBe(true);
		expect(result.owner).toBe("litus");
		expect(result.repo).toBe("succeeds");

		// FR-009: terminal `.workflow-card` is rendered in `#card-strip`.
		await expect(app.workflowCards()).toHaveCount(1, { timeout: 10_000 });

		// FR-010 / SC-002: reload the same page/context and confirm the card
		// survives via WorkflowStore persistence.
		await page.reload();
		await app.waitConnected();
		await expect(app.workflowCards()).toHaveCount(1, { timeout: 10_000 });
	});

	test("failure path: surfaces error on modal, no workflow card", async ({ page, server }) => {
		const observer = new ServerMessageObserver(page);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const form = new SpecFormPage(page);

		const { errorMessage } = await clonedRepo(app, observer, {
			repo: "https://github.com/litus/fails.git",
			specification: "does not matter — clone fails before spec runs",
			expect: "error",
		});

		// FR-011: `.modal-error` visible and surfaces the scripted git error
		// rather than a stub/placeholder — tolerant to wording changes.
		expect(errorMessage ?? "").toMatch(/repository|not found|failed/i);
		await expect(form.errorMessage()).toBeVisible();
		await expect(form.errorMessage()).toHaveText(/repository|not found|failed/i);

		// No workflow card was created for the failed clone.
		await expect(app.workflowCards()).toHaveCount(0);

		// Dismiss the failure modal.
		await page.keyboard.press("Escape");
		await expect(form.modal()).toBeHidden();
	});
});
