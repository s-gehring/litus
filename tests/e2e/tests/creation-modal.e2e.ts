import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import { ServerMessageObserver } from "../helpers";
import { AppPage, SpecFormPage } from "../pages";

// US1 — entry-modal behavioural coverage. Validation, repo chooser,
// keyboard accessibility. Effort selector (FR-005) and over-length
// validation (FR-003) were descoped from this feature (no production
// changes), so those tests are not included.
test.use({ scenarioName: "happy-path", autoMode: "manual" });

async function openCreationModal(page: Page, baseUrl: string) {
	const observer = new ServerMessageObserver(page);
	const app = new AppPage(page);
	await app.goto(baseUrl);
	await app.waitConnected();
	const form = new SpecFormPage(page);
	await app.newSpecButton().click();
	await expect(form.modal()).toBeVisible();
	return { observer, app, form };
}

test.describe("creation modal", () => {
	test("empty specification submit is rejected with visible message", async ({ page, server }) => {
		test.setTimeout(30_000);

		const { observer, form } = await openCreationModal(page, server.baseUrl);

		// Click Submit with an empty spec. The modal must stay open, the inline
		// error must surface, and no `workflow:created` broadcast must fire.
		await form.submitButton().click();
		await expect(form.errorMessage()).toBeVisible();
		await expect(form.errorMessage()).toContainText(/required/i);
		await expect(form.modal()).toBeVisible();

		// Give the server a short grace window; a stray `workflow:created` would
		// ride the same WS and we want to catch that regression.
		await page.waitForTimeout(1_000);
		expect(observer.hasReceived((m) => m.type === "workflow:created")).toBe(false);
	});

	test("existing managed-repo submission creates workflow with that path", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(60_000);

		const { observer, form } = await openCreationModal(page, server.baseUrl);

		await form.repoInput().fill(sandbox.targetRepo);
		await form.repoInput().blur();
		await expect(form.fieldSuccess()).toBeVisible({ timeout: 10_000 });
		await form.specificationInput().fill("Add an existing-managed-repo smoke test.");
		// Set up the waitFor BEFORE clicking submit — otherwise the broadcast
		// can race past the listener during the `toBeHidden` poll.
		const createdPromise = observer.waitFor((m) => m.type === "workflow:created", 15_000);
		await form.submitButton().click();

		await expect(form.modal()).toBeHidden({ timeout: 15_000 });
		const created = await createdPromise;
		// `workflow:created` carries the full workflow record — assert its
		// `targetRepository` round-trips the path we typed.
		const workflow = (created as { workflow?: { targetRepository?: string } }).workflow;
		expect(workflow?.targetRepository).toBe(sandbox.targetRepo);
	});

	test("new-folder path blocks submit with inline validation alert", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(30_000);

		const { observer, form } = await openCreationModal(page, server.baseUrl);

		const missing = join(sandbox.homeDir, "definitely-not-a-real-folder-xyz");
		await form.repoInput().fill(missing);
		await form.specificationInput().fill("Spec with a missing target folder.");
		await form.submitButton().click();

		await expect(form.fieldError()).toBeVisible({ timeout: 10_000 });
		await expect(form.fieldError()).toContainText(/does not exist/i);
		await expect(form.modal()).toBeVisible();

		await page.waitForTimeout(1_000);
		expect(observer.hasReceived((m) => m.type === "workflow:created")).toBe(false);
	});

	test("Escape closes modal without creating a workflow", async ({ page, server }) => {
		test.setTimeout(30_000);

		const { observer, form } = await openCreationModal(page, server.baseUrl);

		await page.keyboard.press("Escape");
		await expect(form.modal()).toBeHidden({ timeout: 5_000 });

		await page.waitForTimeout(1_000);
		expect(observer.hasReceived((m) => m.type === "workflow:created")).toBe(false);
	});

	test("Tab/Shift+Tab wraps focus inside modal (focus trap)", async ({ page, server }) => {
		test.setTimeout(30_000);

		const { form } = await openCreationModal(page, server.baseUrl);

		// Count-based traversal mirrors `peripheral-coverage.e2e.ts:133-175`.
		// Asserting by identity alone would pass a buggy trap that still hits
		// the same element after one extra cycle; counting the tabbable set and
		// pressing Tab that many times proves the loop truly cycles.
		// Selector is intentionally narrower than peripheral-coverage's:
		// it mirrors the exact list walked by `createModal`'s Tab handler in
		// `src/client/components/creation-modal.ts`, so the test pins to the
		// production focus-trap set (not the broader a11y superset).
		const tabbableSelector =
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
		const tabbableCount = await form
			.modal()
			.evaluate((el, sel) => el.querySelectorAll(sel).length, tabbableSelector);
		expect(tabbableCount).toBeGreaterThanOrEqual(2);

		// Focus the first tabbable, press Tab N times → focus must return to
		// the same element after a full cycle.
		await form
			.modal()
			.evaluate(
				(el, sel) => (el.querySelector(sel) as HTMLElement | null)?.focus(),
				tabbableSelector,
			);
		for (let i = 0; i < tabbableCount; i++) await page.keyboard.press("Tab");
		const focusedFirstForward = await form
			.modal()
			.evaluate((el, sel) => el.querySelector(sel) === document.activeElement, tabbableSelector);
		expect(focusedFirstForward).toBe(true);

		// Shift+Tab from the first tabbable must wrap backwards to the last.
		await form
			.modal()
			.evaluate(
				(el, sel) => (el.querySelector(sel) as HTMLElement | null)?.focus(),
				tabbableSelector,
			);
		await page.keyboard.press("Shift+Tab");
		const focusedLastBackward = await form.modal().evaluate((el, sel) => {
			const all = el.querySelectorAll(sel);
			return all[all.length - 1] === document.activeElement;
		}, tabbableSelector);
		expect(focusedLastBackward).toBe(true);
	});
});
