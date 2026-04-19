import { readFile } from "node:fs/promises";
import { devices } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import { createSpecification, deepLink, openArtifact, triggerFailure } from "../helpers";
import {
	AlertsPage,
	AppPage,
	ArtifactViewerPage,
	ConfigPageObject,
	DashboardLayoutPage,
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

		// AS2: after the 5s auto-dismiss window, the toast is gone but the
		// bell count persists AND the alert remains in the alert list. The
		// bell badge alone could regress to an "unread" counter wired to
		// something other than list membership — opening the list closes
		// the loop so AS2 reads membership, not just badge presence.
		await expect(alerts.toasts().first()).toBeHidden({ timeout: 10_000 });
		await expect(alerts.bellCount()).toBeVisible();
		await alerts.openList();
		await expect(alerts.listRows()).toHaveCount(1);
		await alerts.closeList();

		// Drive a second failure so we can assert manual dismissal decrements the count.
		await triggerFailure(app, alerts, {
			specification: "Second alerts scenario workflow",
			repo: sandbox.targetRepo,
		});
		const afterSecond = await alerts.currentBellCount();
		expect(afterSecond).toBeGreaterThanOrEqual(2);

		// AS3: manual dismiss decrements the bell count.
		await alerts.openList();
		const firstRow = alerts.listRows().first();
		await expect(firstRow).toBeVisible();
		await alerts.dismissButton(firstRow).click();
		await expect
			.poll(async () => alerts.currentBellCount(), { timeout: 10_000 })
			.toBeLessThan(afterSecond);

		// AS4/AS5: reload — undismissed alerts survive, dismissed ones do not.
		// Rows are sorted newest-first, so `listRows().first()` in AS3 above
		// dismissed the *second* failure's alert. Post-reload, the list must
		// contain the first-failure row and must NOT contain the dismissed
		// second-failure row. A plain bell-count check would silently pass a
		// regression that dropped the surviving alert AND resurrected the
		// dismissed one (1 → 1).
		const beforeReload = await alerts.currentBellCount();
		await page.reload();
		await app.waitConnected();
		await expect
			.poll(async () => alerts.currentBellCount(), { timeout: 15_000 })
			.toBe(beforeReload);
		await alerts.openList();
		await expect(alerts.listRows()).toHaveCount(1);
		await expect(alerts.listPanel()).toContainText("First alerts scenario workflow");
		await expect(alerts.listPanel()).not.toContainText("Second alerts scenario workflow");
		await alerts.closeList();
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
		await expect(card.stepIndicator("specify")).toHaveClass(/\bstep-completed\b/, {
			timeout: 90_000,
		});
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
		expect(bodyHtml).not.toMatch(/href=["']javascript:/i);

		// AS5: focus trap — focusing the LAST tabbable element (the close
		// button) and pressing Tab once must wrap forward to the FIRST (the
		// download link). This is the only case the trap actually handles —
		// pressing Tab between interior tabbables is just the browser's default,
		// which doesn't prove the trap's wrap logic at all.
		await viewer.closeButton().focus();
		await page.keyboard.press("Tab");
		const focusedDownloadLink = await viewer
			.downloadLink()
			.evaluate((el) => el === document.activeElement);
		expect(focusedDownloadLink).toBe(true);

		// Shift+Tab on the first tabbable (download link) wraps back to the
		// last (close button). The trap's two branches (forward and backward)
		// are both exercised — regressions that break only one direction
		// would otherwise slip through.
		await viewer.downloadLink().focus();
		await page.keyboard.press("Shift+Tab");
		const focusedClose = await viewer.closeButton().evaluate((el) => el === document.activeElement);
		expect(focusedClose).toBe(true);

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

		// Close with Escape; the modal hides. We do NOT assert focus is restored
		// to the opener affordance — `renderPipelineSteps` rebuilds all
		// affordance buttons on every `workflow:state` broadcast
		// (`pipeline-steps.ts:container.replaceChildren()`), so the stored
		// `triggerEl` reference points at a detached node by the time the modal
		// closes. That DOM-identity concern is a product-code contract, not
		// something the test can guard without a stable selector-based
		// reacquisition.
		await page.keyboard.press("Escape");
		await expect(viewer.modal()).toBeHidden();

		// FR-006a: URL-encoded artifact filename is listed, viewable, AND
		// downloadable. Download the file and assert the suggested filename
		// round-trips through `encodeURIComponent` intact — this is where
		// double-encoding / decode-mismatch regressions show up.
		await expect(card.stepIndicator("plan")).toHaveClass(/\bstep-completed\b/, { timeout: 90_000 });
		await viewer.affordanceForStep("Planning").click();
		const encodedItem = viewer.dropdownItemByLabel("contracts/example artifact #1.md");
		await expect(encodedItem).toBeVisible();
		await encodedItem.click();
		await expect(viewer.modalBody()).toContainText("URL-encoded filename", {
			timeout: 15_000,
		});
		const [encodedDownload] = await Promise.all([
			page.waitForEvent("download"),
			viewer.downloadLink().click(),
		]);
		// Server prefixes the sanitized branch name; assert the basename
		// (including the space and '#') round-trips through Content-Disposition
		// without double-encoding.
		expect(encodedDownload.suggestedFilename()).toContain("example artifact #1.md");
		// Verify the bytes too — filename echo alone doesn't prove the
		// encode/decode round-trip delivered the actual file content.
		const encodedPath = await encodedDownload.path();
		expect(encodedPath).toBeTruthy();
		const encodedBytes = await readFile(encodedPath as string, "utf8");
		expect(encodedBytes).toContain("URL-encoded filename");
		await page.keyboard.press("Escape");
		await expect(viewer.modal()).toBeHidden();

		// US2 AS3: the PNG image artifact opens in the modal. Research D3
		// scoped this to "the modal renders without error and carries a
		// user-visible reference to the filename". The modal itself is
		// markdown-rendering the raw bytes (not a dedicated image renderer),
		// so assert on the modal title (filename) + non-empty download bytes,
		// not on a DOM `<img>` element.
		await openArtifact(viewer, "Planning", "pixel.png");
		await expect(viewer.modalTitle()).toContainText("pixel.png");
		const [imageDownload] = await Promise.all([
			page.waitForEvent("download"),
			viewer.downloadLink().click(),
		]);
		expect(imageDownload.suggestedFilename()).toContain("pixel.png");
		const imagePath = await imageDownload.path();
		expect(imagePath).toBeTruthy();
		const imageBytes = await readFile(imagePath as string);
		expect(imageBytes.byteLength).toBeGreaterThan(0);
		// PNG magic bytes — confirms the base64 decode round-trip produced a
		// valid PNG, not a corrupted payload.
		expect(imageBytes[0]).toBe(0x89);
		expect(imageBytes[1]).toBe(0x50);
		expect(imageBytes[2]).toBe(0x4e);
		expect(imageBytes[3]).toBe(0x47);
		await page.keyboard.press("Escape");
	});
});

// ── Routing ─────────────────────────────────────────────────

test.describe("routing", () => {
	// Routing assertions never spawn a workflow, so load the small
	// `peripheral-alerts` scenario rather than the 20-entry happy-path. This
	// removes the "why happy-path?" reader surprise without affecting coverage.
	test.use({ scenarioName: "peripheral-alerts", autoMode: "manual" });

	test("deep links + back/forward + refresh + not-found", async ({ page, server, sandbox }) => {
		test.setTimeout(120_000);

		const app = new AppPage(page);
		const welcome = new WelcomePage(page);
		const config = new ConfigPageObject(page);
		const notFound = new NotFoundPage(page);
		const layout = new DashboardLayoutPage(page);

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

		// Seed a real workflow first so the not-found navigation actually has
		// a stale-content surface to leak from. Without this, the
		// `#pipeline-steps .pipeline-step` count-zero assertion below is a
		// tautology — `#pipeline-steps` is never populated by the prior
		// welcome / config / back-forward steps.
		await deepLink(app, server.baseUrl, "/");
		// The `peripheral-alerts` scenario's first claude entry has
		// `exitCode: 1`, so this seeded workflow *fails by design* and a
		// background alert toast may fire during the routing assertions
		// below. The routing assertions key on `notFound.root()` /
		// `welcome.root()` / `config.root()` visibility, not on toast
		// absence, so the stray alert is load-bearing-irrelevant — flagging
		// the non-obvious invariant so future reorderings stay safe.
		await createSpecification(app, {
			specification: "Routing seed workflow",
			repo: sandbox.targetRepo,
		});
		const seededCard = app.workflowCards().first();
		await expect(seededCard).toBeVisible({ timeout: 30_000 });
		await seededCard.click();
		await expect(layout.pipelineStepRows().first()).toBeVisible({
			timeout: 30_000,
		});
		const seededId = await seededCard.getAttribute("data-workflow-id");
		expect(seededId).toBeTruthy();
		if (!seededId) throw new Error("unreachable: seededId truthy-asserted above");
		// FR-008: the card-strip selection state tracks the URL. After clicking
		// the card the matching strip entry must carry the `card-expanded`
		// class (the strip's "this card is selected" affordance).
		await expect(seededCard).toHaveClass(/\bcard-expanded\b/);

		// FR-008 deep-link → card-strip selection: navigate away then deep-link
		// straight back to `/workflow/<id>` and assert the strip re-selects the
		// matching card without a click.
		await deepLink(app, server.baseUrl, "/");
		await expect(seededCard).not.toHaveClass(/\bcard-expanded\b/);
		await deepLink(app, server.baseUrl, `/workflow/${seededId}`);
		await expect(seededCard).toHaveClass(/\bcard-expanded\b/);

		// AS4: back/forward across a card-strip-selected view. popstate must
		// re-apply the `card-expanded` class on the seeded workflow when we
		// navigate back to `/workflow/<id>` — the previous welcome↔config
		// hops never exercised a selected card so a regression in popstate's
		// selection reapply would have slipped.
		await deepLink(app, server.baseUrl, "/config");
		await expect(config.root()).toBeVisible();
		await page.goBack();
		await expect(seededCard).toHaveClass(/\bcard-expanded\b/);
		await page.goForward();
		await expect(config.root()).toBeVisible();

		// AS5: refresh on a seeded `/workflow/<id>` deep-link must restore the
		// same view + card-strip selection after reconnect. The welcome/config
		// reloads above don't exercise the `workflow:list` re-render path.
		await deepLink(app, server.baseUrl, `/workflow/${seededId}`);
		await page.reload();
		await app.waitConnected();
		await expect(seededCard).toHaveClass(/\bcard-expanded\b/);

		await deepLink(app, server.baseUrl, "/workflow/does-not-exist");
		await expect(notFound.root()).toBeVisible();
		await expect(notFound.message()).toContainText(/workflow/i);
		// Also assert the id round-trips into the message so regressions
		// where the panel receives the wrong id (or the route handler passes
		// the wrong one) surface here.
		await expect(notFound.message()).toContainText(/does-not-exist/);
		// With a real workflow seeded above, `#pipeline-steps` carries the
		// seeded workflow's step rows; the not-found mount must clear them so
		// the empty-state owns the detail surface. This is the genuine
		// stale-leak class — without the seed step the assertion was a
		// tautology.
		await expect(layout.pipelineStepRows()).toHaveCount(0);

		// AS5: refresh on the not-found panel must re-render the empty-state
		// rather than briefly flashing stale content or the welcome area.
		await page.reload();
		await app.waitConnected();
		await expect(notFound.root()).toBeVisible();
		await expect(notFound.message()).toContainText(/does-not-exist/);

		// Re-seed `#pipeline-steps` by returning to the seeded workflow view —
		// the `/workflow/does-not-exist` transition above already cleared the
		// strip, so a count-zero assertion after the epic not-found nav would
		// otherwise be comparing zero-to-zero and exercise no product-code
		// invariant.
		await deepLink(app, server.baseUrl, `/workflow/${seededId}`);
		await expect(layout.pipelineStepRows().first()).toBeVisible({ timeout: 30_000 });

		// `also-missing` is chosen to collide with neither a seeded epic id nor
		// an aggregate key — the epic detail handler falls through to
		// `showNotFoundPanel("epic", …)`. Keep this id free of any fixture data
		// added later so the assertion stays meaningful.
		await deepLink(app, server.baseUrl, "/epic/also-missing");
		await expect(notFound.root()).toBeVisible();
		await expect(notFound.message()).toContainText(/epic/i);
		await expect(notFound.message()).toContainText(/also-missing/);
		await expect(layout.pipelineStepRows()).toHaveCount(0);
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
		const layout = new DashboardLayoutPage(page);
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

		// AS2: per-card step indicators progress independently. Key the
		// observed-step sets by `data-workflow-id` so a future card-strip
		// re-order (by status/recency/id) can't silently mix the two cards'
		// samples. "Independent" is stronger than "each progressed" — also
		// require at least one poll where the two cards' current step texts
		// differ, catching regressions (shared module-scope "current step",
		// wrong data-workflow-id lookup) that would otherwise have both cards
		// progress in lockstep and still satisfy the size ≥ 2 check.
		// Accumulators are monotonic so they survive completion — `.card-step`
		// only renders while the workflow is `running`/`waiting_for_input`,
		// which would make an equality-based poll false-forever once both
		// workflows finish.
		const observedSteps = new Map<string, Set<string>>();
		let sawDivergence = false;
		await expect
			.poll(
				async () => {
					const samples = await cards.evaluateAll((els) =>
						els.map((el) => ({
							id: el.getAttribute("data-workflow-id") ?? "",
							step: el.querySelector(".card-step")?.textContent ?? "",
						})),
					);
					for (const { id, step } of samples) {
						if (!id || !step) continue;
						let set = observedSteps.get(id);
						if (!set) {
							set = new Set();
							observedSteps.set(id, set);
						}
						set.add(step);
					}
					if (samples.length === 2 && samples[0].step && samples[1].step) {
						if (samples[0].id !== samples[1].id && samples[0].step !== samples[1].step) {
							sawDivergence = true;
						}
					}
					if (observedSteps.size < 2) return false;
					const sizes = [...observedSteps.values()].map((s) => s.size);
					return sizes.every((n) => n >= 2) && sawDivergence;
				},
				{ timeout: 90_000 },
			)
			.toBe(true);

		// AS3: clicking each card swaps the detail pane — assert the
		// `#user-input` text binds to the selected workflow. Bind cards by
		// their summary text rather than `nth(0)/nth(1)` so the assertion
		// stays diagnostic if a future card-strip change re-orders by status,
		// recency, or id (an order flip would otherwise silently flip the
		// mapping and re-pass the test for the wrong reason).
		const cardOne = cards.filter({ hasText: "Concurrency spec one" });
		const cardTwo = cards.filter({ hasText: "Concurrency spec two" });
		await expect(cardOne).toHaveCount(1);
		await expect(cardTwo).toHaveCount(1);
		await cardOne.click();
		await expect(layout.detailArea()).toBeVisible();
		await expect(layout.userInput()).toContainText("Concurrency spec one", {
			timeout: 15_000,
		});
		// Guard against append-instead-of-replace regressions: a substring
		// match alone passes spuriously when both texts end up concatenated.
		await expect(layout.userInput()).not.toContainText("Concurrency spec two");
		await cardTwo.click();
		await expect(layout.detailArea()).toBeVisible();
		await expect(layout.userInput()).toContainText("Concurrency spec two", {
			timeout: 15_000,
		});
		await expect(layout.userInput()).not.toContainText("Concurrency spec one");

		// AS4: both cards eventually reach a `card-status-completed` badge.
		// Full-auto drives through merge-pr; the scenario has 8 scripted
		// claude calls per workflow, matching the actual step count.
		await expect
			.poll(
				async () => {
					const classes = await cards.evaluateAll((els) =>
						els.map((el) => el.querySelector(".card-status")?.className ?? ""),
					);
					return classes.length === 2 && classes.every((c) => /\bcard-status-completed\b/.test(c));
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
		const layout = new DashboardLayoutPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createSpecification(app, {
			specification: "Responsive artifact flow",
			repo: sandbox.targetRepo,
		});

		await expect(app.workflowCards().first()).toBeVisible();
		await app.workflowCards().first().click();
		await expect(layout.detailArea()).toBeVisible();

		await expect(card.stepIndicator("specify")).toHaveClass(/\bstep-completed\b/, {
			timeout: 90_000,
		});

		await expect(viewer.anyAffordance()).toBeVisible({ timeout: 30_000 });
		await openArtifact(viewer, "Specifying", "spec.md");
		await expect(viewer.modal()).toBeVisible();
		// Gate the close on rendered content so a regression where the
		// modal opens empty and is dismissed before `/content` resolves
		// doesn't pass this smoke silently.
		await expect(viewer.modalBody()).toContainText("Artifact XSS test", { timeout: 15_000 });
		await page.keyboard.press("Escape");
		await expect(viewer.modal()).toBeHidden();

		// FR-010: card strip must not overflow the 375px viewport horizontally,
		// and the pipeline-steps strip (visible after selecting the card) must
		// be visible and not horizontally overflow. The epic-tree component
		// (`#output-area.epic-tree-fullsize`) is epic-bound and not rendered
		// here — this smoke does not assert on it.
		const viewport = page.viewportSize();
		expect(viewport).not.toBeNull();
		// `+ 1` absorbs sub-pixel rounding in `boundingBox` (Chromium reports
		// fractional widths rounded to one decimal): strictly-equal widths
		// trip a naive `<=` by ~0.5px on some devicePixelRatio values. Not a
		// flake-avoidance fudge — a subpixel-rendering tolerance.
		const stripBox = await layout.cardStrip().boundingBox();
		expect(stripBox).not.toBeNull();
		if (stripBox && viewport) {
			expect(stripBox.x).toBeGreaterThanOrEqual(0);
			expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(viewport.width + 1);
		}
		const pipelineStrip = layout.pipelineSteps();
		await expect(pipelineStrip).toBeVisible();
		const pipelineStripBox = await pipelineStrip.boundingBox();
		expect(pipelineStripBox).not.toBeNull();
		if (pipelineStripBox && viewport) {
			expect(pipelineStripBox.x + pipelineStripBox.width).toBeLessThanOrEqual(viewport.width + 1);
		}
	});
});
