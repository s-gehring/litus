import { readFile } from "node:fs/promises";
import { devices } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import { createSpecification, deepLink, openArtifact, triggerFailure } from "../helpers";
import {
	AlertsPage,
	AppPage,
	ArtifactViewerPage,
	ConfigPageObject,
	NotFoundPage,
	WelcomePage,
	WorkflowCardPage,
} from "../pages";

// ── Alerts ──────────────────────────────────────────────────

test.describe("alerts", () => {
	test.use({ scenarioName: "peripheral-alerts", autoMode: "manual" });

	test("bell + toast + list + reload persistence", async ({ page, server, sandbox }) => {
		test.setTimeout(120_000);

		const app = new AppPage(page);
		const alerts = new AlertsPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		// AS1: first scripted failure → bell count increments, toast appears.
		await triggerFailure(app, alerts, {
			specification: "First alerts scenario workflow",
			repo: sandbox.targetRepo,
		});
		await expect(alerts.bellCount()).toBeVisible();
		await expect(alerts.bellCount()).toHaveText(/^[1-9]\d*$/);
		await expect(alerts.toasts().first()).toBeVisible();

		// AS2: after the 5s auto-dismiss window, the toast is gone but the bell count persists.
		await expect(alerts.toasts().first()).toBeHidden({ timeout: 10_000 });
		await expect(alerts.bellCount()).toBeVisible();

		// Drive a second failure so we can assert manual dismissal decrements the count.
		await triggerFailure(app, alerts, {
			specification: "Second alerts scenario workflow",
			repo: sandbox.targetRepo,
		});
		const afterSecond = Number.parseInt((await alerts.bellCount().textContent()) ?? "0", 10);
		expect(afterSecond).toBeGreaterThanOrEqual(2);

		// AS3: manual dismiss decrements the bell count.
		await alerts.openList();
		const firstRow = alerts.listRows().first();
		await expect(firstRow).toBeVisible();
		await alerts.dismissButton(firstRow).click();
		await expect
			.poll(async () => Number.parseInt((await alerts.bellCount().textContent()) ?? "0", 10), {
				timeout: 10_000,
			})
			.toBeLessThan(afterSecond);

		// AS4/AS5: reload — undismissed alerts survive, dismissed ones do not.
		const beforeReload = Number.parseInt((await alerts.bellCount().textContent()) ?? "0", 10);
		await page.reload();
		await app.waitConnected();
		await expect
			.poll(async () => Number.parseInt((await alerts.bellCount().textContent()) ?? "0", 10), {
				timeout: 15_000,
			})
			.toBe(beforeReload);
	});
});

// ── Artifacts ───────────────────────────────────────────────

test.describe("artifacts", () => {
	test.use({ scenarioName: "peripheral-artifacts", autoMode: "manual" });

	test("list + XSS sanitisation + download + focus trap", async ({ page, server, sandbox }) => {
		test.setTimeout(180_000);

		const app = new AppPage(page);
		const card = new WorkflowCardPage(page);
		const viewer = new ArtifactViewerPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createSpecification(app, {
			specification: "Artifacts coverage run",
			repo: sandbox.targetRepo,
		});

		// Wait for specify to produce its artifact snapshot (spec.md with XSS).
		await expect(card.stepIndicator("specify")).toHaveClass(/step-completed/, { timeout: 90_000 });
		await expect(viewer.anyAffordance()).toBeVisible({ timeout: 30_000 });

		// Install a sentinel — the injected script, onerror, or javascript: URL
		// must NOT set window.__XSS. DOMPurify strips all three.
		await page.evaluate(() => {
			(window as unknown as Record<string, unknown>).__XSS = undefined;
		});

		// AS1/AS2: open spec.md. The modal body starts as "Loading…" until the
		// `/content` fetch resolves — gate all sanitiser assertions on the
		// rendered title text ("Artifact XSS test" from the scenario fixture),
		// otherwise the XSS checks race the fetch and pass trivially on an
		// empty body.
		await openArtifact(viewer, "Specifying", "spec.md");
		await expect(viewer.modalBody()).toContainText("Artifact XSS test", { timeout: 15_000 });

		const xssFlag = await page.evaluate(() => (window as unknown as Record<string, unknown>).__XSS);
		expect(xssFlag).toBeUndefined();
		const bodyHtml = await viewer.modalBody().innerHTML();
		expect(bodyHtml).not.toMatch(/<script/i);
		expect(bodyHtml).not.toMatch(/onerror=/i);
		expect(bodyHtml.toLowerCase()).not.toContain('href="javascript:');

		// AS5: focus trap — tabbing past the last focusable element wraps back
		// to the first (the download link); Escape closes and restores focus to
		// the opener.
		await viewer.downloadLink().focus();
		const tabbableCount = await page.evaluate(() => {
			const dialog = document.querySelector(".artifact-modal");
			if (!dialog) return 0;
			const sel =
				'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
			return dialog.querySelectorAll(sel).length;
		});
		expect(tabbableCount).toBeGreaterThan(0);
		// Press Tab one more time than there are focusable elements — the last
		// press must wrap to the first focusable node without escaping the
		// dialog.
		for (let i = 0; i < tabbableCount + 1; i++) {
			await page.keyboard.press("Tab");
		}
		const wrappedInsideDialog = await page.evaluate(
			() => document.activeElement?.closest(".artifact-modal") !== null,
		);
		expect(wrappedInsideDialog).toBe(true);

		// AS4: download fires and delivers the spec.md bytes unchanged — the
		// sanitiser is a render-time concern; on-disk bytes must preserve every
		// XSS vector string so a human downloading the file sees the real
		// source. A plain click on the `<a download>` triggers the download
		// event on Chromium (the only configured Playwright project here).
		const [download] = await Promise.all([
			page.waitForEvent("download"),
			viewer.downloadLink().click(),
		]);
		expect(download.suggestedFilename()).toMatch(/spec/);
		const downloadPath = await download.path();
		expect(downloadPath).toBeTruthy();
		const downloaded = await readFile(downloadPath as string, "utf8");
		expect(downloaded).toContain("<script>window.__XSS");
		expect(downloaded).toMatch(/onerror=/);
		expect(downloaded).toContain("javascript:window.__XSS");

		// Close with Escape, verify focus returns to the affordance that
		// opened the modal, then check the plan-step artifact with a
		// URL-encoded filename appears in its dropdown.
		const openerHandle = viewer.affordanceForStep("Specifying");
		await page.keyboard.press("Escape");
		await expect(viewer.modal()).toBeHidden();
		const openerIsActive = await openerHandle.evaluate((el) => el === document.activeElement);
		expect(openerIsActive).toBe(true);

		await expect(card.stepIndicator("plan")).toHaveClass(/step-completed/, { timeout: 90_000 });
		await viewer.affordanceForStep("Planning").click();
		await expect(viewer.dropdownItemByLabel("contracts/example artifact #1.md")).toBeVisible();
		await page.keyboard.press("Escape");
	});
});

// ── Routing ─────────────────────────────────────────────────

test.describe("routing", () => {
	test.use({ scenarioName: "happy-path", autoMode: "manual" });

	test("deep links + back/forward + refresh + not-found", async ({ page, server }) => {
		test.setTimeout(60_000);

		const app = new AppPage(page);
		const welcome = new WelcomePage(page);
		const config = new ConfigPageObject(page);
		const notFound = new NotFoundPage(page);

		// Pass `server.baseUrl` explicitly to every `deepLink` call — the helper
		// no longer derives the origin from `page.url()` (which is `about:blank`
		// before the first navigation and silently produces unreachable
		// `about:///…` URLs).
		await deepLink(app, server.baseUrl, "/");
		await expect(welcome.root()).toBeVisible();

		await deepLink(app, server.baseUrl, "/config");
		await expect(config.root()).toBeVisible();

		await page.goBack();
		await expect(welcome.root()).toBeVisible();

		await page.goForward();
		await expect(config.root()).toBeVisible();

		await page.reload();
		await app.waitConnected();
		await expect(config.root()).toBeVisible();

		await deepLink(app, server.baseUrl, "/workflow/does-not-exist");
		await expect(notFound.root()).toBeVisible();
		await expect(notFound.message()).toContainText(/workflow/i);

		// `also-missing` is chosen to collide with neither a seeded epic id nor
		// an aggregate key — the epic detail handler falls through to
		// `showNotFoundPanel("epic", …)`. Keep this id free of any fixture data
		// added later so the assertion stays meaningful.
		await deepLink(app, server.baseUrl, "/epic/also-missing");
		await expect(notFound.root()).toBeVisible();
		await expect(notFound.message()).toContainText(/epic/i);
	});
});

// ── Concurrency ─────────────────────────────────────────────

test.describe("concurrency", () => {
	test.use({ scenarioName: "peripheral-concurrency", autoMode: "full-auto" });

	test("two parallel specs progress independently and complete", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(180_000);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createSpecification(app, {
			specification: "Concurrency spec one",
			repo: sandbox.targetRepo,
		});
		await createSpecification(app, {
			specification: "Concurrency spec two",
			repo: sandbox.targetRepo,
		});

		// AS1: both cards appear in the strip.
		await expect(app.workflowCards()).toHaveCount(2, { timeout: 30_000 });

		const cards = app.workflowCards();

		// AS2: per-card step indicators progress independently — at some point
		// in the interleaved run, the two `.card-step` texts diverge. Poll
		// until at least one card shows a non-empty step AND the two step
		// texts differ (i.e. the cards are not in lockstep).
		await expect
			.poll(
				async () => {
					const steps = await cards.evaluateAll((els) =>
						els.map((el) => el.querySelector(".card-step")?.textContent ?? ""),
					);
					return (
						steps.length === 2 && steps[0] !== steps[1] && (steps[0] !== "" || steps[1] !== "")
					);
				},
				{ timeout: 60_000 },
			)
			.toBe(true);

		// AS3: clicking each card swaps the detail pane — assert the
		// `#pipeline-steps` content actually changes identity between clicks.
		await cards.nth(0).click();
		await expect(page.locator("#detail-area")).toBeVisible();
		const firstDetailFingerprint = await page
			.locator("#pipeline-steps")
			.evaluate((el) => el.innerHTML);
		await cards.nth(1).click();
		await expect(page.locator("#detail-area")).toBeVisible();
		await expect
			.poll(async () => page.locator("#pipeline-steps").evaluate((el) => el.innerHTML), {
				timeout: 15_000,
			})
			.not.toBe(firstDetailFingerprint);

		// AS4: both cards eventually reach a `card-status-completed` badge.
		// Full-auto drives through merge-pr; the scenario has 8 scripted
		// claude calls per workflow, matching the actual step count.
		await expect
			.poll(
				async () => {
					const classes = await cards.evaluateAll((els) =>
						els.map((el) => el.querySelector(".card-status")?.className ?? ""),
					);
					return classes.length === 2 && classes.every((c) => c.includes("card-status-completed"));
				},
				{ timeout: 120_000 },
			)
			.toBe(true);
	});
});

// ── Responsive ──────────────────────────────────────────────

test.describe("responsive", () => {
	test.use({
		scenarioName: "peripheral-artifacts",
		autoMode: "manual",
		...devices["iPhone SE"],
	});

	test("iPhone SE: dashboard → card → artifact viewer", async ({ page, server, sandbox }) => {
		test.setTimeout(180_000);

		const app = new AppPage(page);
		const card = new WorkflowCardPage(page);
		const viewer = new ArtifactViewerPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createSpecification(app, {
			specification: "Responsive artifact flow",
			repo: sandbox.targetRepo,
		});

		await expect(app.workflowCards().first()).toBeVisible();
		await app.workflowCards().first().click();
		await expect(page.locator("#detail-area")).toBeVisible();

		await expect(card.stepIndicator("specify")).toHaveClass(/step-completed/, {
			timeout: 90_000,
		});

		await expect(viewer.anyAffordance()).toBeVisible({ timeout: 30_000 });
		await openArtifact(viewer, "Specifying", "spec.md");
		await expect(viewer.modal()).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(viewer.modal()).toBeHidden();

		// FR-010: card strip must not overflow the 375px viewport horizontally,
		// and the pipeline tree (visible after selecting the card) must be
		// visible and not horizontally clip the card strip.
		const viewport = page.viewportSize();
		expect(viewport).not.toBeNull();
		const stripBox = await page.locator("#card-strip").boundingBox();
		expect(stripBox).not.toBeNull();
		if (stripBox && viewport) {
			expect(stripBox.x).toBeGreaterThanOrEqual(0);
			expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(viewport.width + 1);
		}
		const tree = page.locator("#pipeline-steps");
		await expect(tree).toBeVisible();
		const treeBox = await tree.boundingBox();
		expect(treeBox).not.toBeNull();
		if (treeBox && viewport) {
			expect(treeBox.x + treeBox.width).toBeLessThanOrEqual(viewport.width + 1);
		}
	});
});
