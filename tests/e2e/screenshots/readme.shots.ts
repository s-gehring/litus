/**
 * README screenshot harness.
 *
 * Each `test()` here drives the same fixtures as the e2e suite to a curated
 * UI state, then writes one or more PNGs into `docs/screenshots/`. These
 * tests are NEVER run by the regular e2e suite — `playwright.config.ts`
 * matches `*.e2e.ts` while this file uses `*.shots.ts`. To regenerate the
 * README screenshots, run `bun run capture:screenshots`.
 *
 * Page focus matters here: a screenshot taken at the wrong moment captures
 * empty state or a transition. Each test waits for the specific surface to
 * be visible/stable before the screenshot call.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import {
	answerClarifyingQuestion,
	createEpic,
	createSpecification,
	startQuickFix,
	waitForStep,
} from "../helpers";
import { AppPage, SpecFormPage, WorkflowCardPage } from "../pages";
import { EpicTree } from "../pages/epic-tree";

const SCREENSHOT_DIR = resolve(
	fileURLToPath(new URL(".", import.meta.url)),
	"..",
	"..",
	"..",
	"docs",
	"screenshots",
);

function shotPath(name: string): string {
	return resolve(SCREENSHOT_DIR, `${name}.png`);
}

/** Hide the alert-toast container before a hero/detail screenshot so a
 * persistent "Question awaiting answer" toast doesn't crop into the corner.
 * Toasts come and go; the screenshots want a clean header. */
async function hideAlertToasts(page: Page): Promise<void> {
	await page.evaluate(() => {
		const el = document.getElementById("alert-toast-container");
		if (el) (el as HTMLElement).style.visibility = "hidden";
	});
}

const SAMPLE_SPEC = "Add a dark mode toggle to the application settings.";
const SAMPLE_FIX = "Fix typo in the greeting helper.";
const SAMPLE_EPIC =
	"Build a horse-matchmaking web application with auth, profiles, and a swipe UI.";
// Use a GitHub URL for modal-only screenshots — URL input is treated as a
// clone target, so no folder-exists check fires and no "Folder does not exist"
// red text appears. Real workflow runs (hero / pipeline / epic) use the
// sandbox-provided local target so validation passes naturally.
const SAMPLE_REPO_URL = "https://github.com/litus/example-repo";

// ---------------------------------------------------------------------------
// Spec workflow — drives the happy-path scenario for hero / pipeline-running
// / question-panel / new-spec / pipeline-spec.
// ---------------------------------------------------------------------------
test.describe("spec workflow screenshots", () => {
	test.use({ scenarioName: "happy-path", autoMode: "manual" });

	test("new specification modal", async ({ page, server }) => {
		test.setTimeout(60_000);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await app.newSpecButton().click();
		const form = new SpecFormPage(page);
		await expect(form.modal()).toBeVisible();
		await form.repoInput().fill(SAMPLE_REPO_URL);
		await form.specificationInput().fill(SAMPLE_SPEC);
		// Move focus into the textarea + commit the field so the URL input
		// settles past blur-time validation without triggering a red error.
		await form.specificationInput().focus();
		await page.waitForTimeout(300);

		await page.screenshot({ path: shotPath("new-spec"), fullPage: false });
	});

	test("workflow detail mid-pipeline (hero + pipeline-running)", async ({
		page,
		server,
		sandbox,
	}) => {
		test.setTimeout(120_000);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createSpecification(app, { specification: SAMPLE_SPEC, repo: sandbox.targetRepo });

		const card = new WorkflowCardPage(page);
		await waitForStep(card, "specify", "completed", { timeoutMs: 60_000 });
		await waitForStep(card, "clarify", "waiting", { timeoutMs: 60_000 });

		// Question panel: take its screenshot first while paused at clarify.
		await hideAlertToasts(page);
		await page.screenshot({ path: shotPath("question-panel"), fullPage: false });

		// Now answer and let it advance into a step that's actively running so
		// the hero/pipeline-running shot has live output.
		await answerClarifyingQuestion(card, "Yes, with a Tailwind dark variant.", {
			expectQuestionContains: "dark mode",
		});
		await waitForStep(card, "plan", "completed", { timeoutMs: 60_000 });
		await waitForStep(card, "tasks", "completed", { timeoutMs: 60_000 });
		// Give the next step's assistant message time to reach the output log
		// — without this the screenshot can race the review-step events and
		// land on an empty output area (just the "— Step: review —" header).
		await expect(page.locator("#output-log")).toContainText("Review complete", {
			timeout: 30_000,
		});

		await hideAlertToasts(page);
		await page.screenshot({ path: shotPath("pipeline-running"), fullPage: false });
		await page.screenshot({ path: shotPath("hero"), fullPage: false });

		// Pipeline-steps bar isolated for the Workflow Kinds section.
		const pipeline = card.pipelineContainer();
		await expect(pipeline).toBeVisible();
		await pipeline.screenshot({ path: shotPath("pipeline-spec") });
	});
});

// ---------------------------------------------------------------------------
// Quick Fix — pipeline-quick-fix screenshot.
// ---------------------------------------------------------------------------
test.describe("quick fix screenshots", () => {
	test.use({ scenarioName: "quick-fix-happy-path", autoMode: "manual" });

	test("quick-fix pipeline bar", async ({ page, server, sandbox }) => {
		test.setTimeout(60_000);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await startQuickFix(app, { description: SAMPLE_FIX, repo: sandbox.targetRepo });

		const card = new WorkflowCardPage(page);
		await waitForStep(card, "fix-implement", "completed", { timeoutMs: 60_000 });

		const pipeline = card.pipelineContainer();
		await expect(pipeline).toBeVisible();
		await pipeline.screenshot({ path: shotPath("pipeline-quick-fix") });
	});
});

// ---------------------------------------------------------------------------
// Epic — epic-tree + pipeline-epic (the dependency view IS the epic pipeline).
// ---------------------------------------------------------------------------
test.describe("epic screenshots", () => {
	// Use the screenshot-only `epic-screenshot` scenario, which scripts an
	// 8-spec / 4-layer dependency graph for the horse-matchmaking sample epic
	// — much more representative of what an Epic decomposition actually looks
	// like than the 2-spec sibling fixtures used by the e2e suite.
	test.use({
		scenarioName: "epic-screenshot",
		autoMode: "manual",
		configOverrides: {
			prompts: {
				epicDecomposition:
					"Decompose this epic into self-contained specs and return a JSON code block. Epic: ${epicDescription}",
			},
			limits: { maxJsonRetries: 1 },
		},
	});

	test("epic dependency tree", async ({ page, server, sandbox }) => {
		test.setTimeout(120_000);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createEpic({
			page,
			description: SAMPLE_EPIC,
			repo: sandbox.targetRepo,
			start: false,
		});

		const tree = new EpicTree(page);
		await expect(tree.container()).toBeVisible({ timeout: 30_000 });
		// Wait until every child node has rendered so the dependency edges
		// aren't captured mid-paint. The screenshot scenario scripts 8 specs.
		await expect(tree.allChildRows()).toHaveCount(8, { timeout: 30_000 });
		await hideAlertToasts(page);

		// Full-page shot for the README's Screenshots overview table.
		await page.screenshot({ path: shotPath("epic-tree"), fullPage: false });
		// Workflow-kinds section wants a tighter shot focused on just the
		// dependency-graph element, paralleling the cropped pipeline-bar
		// shots used for the Spec and Quick Fix kinds. Without this, both
		// PNGs are byte-identical.
		await tree.container().screenshot({ path: shotPath("pipeline-epic") });
	});
});

// ---------------------------------------------------------------------------
// Ask Question — modal + post-submit aspect grid placeholder.
//
// The ask-question scenarios in the e2e tree are stubs (`{}`), so we can't
// drive a full ask-question pipeline screenshot here. Capture the modal as
// the user-facing entry point for now; the README's Workflow Kinds section
// explains the rest in prose.
// ---------------------------------------------------------------------------
test.describe("ask question screenshots", () => {
	test.use({ scenarioName: "ask-question-single-aspect" });

	test("ask question modal", async ({ page, server }) => {
		test.setTimeout(60_000);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await page.locator("#btn-ask-question").click();
		const modal = page
			.locator(".modal-panel")
			.filter({ has: page.locator(".modal-title", { hasText: "Ask Question" }) });
		await expect(modal).toBeVisible({ timeout: 10_000 });

		// Fill the modal with a representative question + repo so the screenshot
		// shows real content rather than empty placeholders. Use a GitHub URL
		// so blur-time folder validation is skipped (URL = clone target).
		await modal.locator(".folder-picker input").fill(SAMPLE_REPO_URL);
		const questionInput = modal.locator("textarea");
		await questionInput.fill(
			"Where in the codebase do we serialize workflow state to disk, and how is the index file kept in sync?",
		);
		await questionInput.focus();
		await page.waitForTimeout(300);

		await page.screenshot({ path: shotPath("pipeline-ask-question"), fullPage: false });
	});
});
