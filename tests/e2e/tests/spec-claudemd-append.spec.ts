import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_CLAUDEMD_SEPARATOR } from "../../../src/claude-md-merger";
import { expect, test } from "../harness/fixtures";
import { createSpecification, waitForStep } from "../helpers";
import { AppPage, WorkflowCardPage } from "../pages";

const PROJECT_CLAUDEMD = "# Project Guidelines (e2e)\n\nBe kind; commit often.\n";

test.use({ scenarioName: "happy-path", autoMode: "manual" });

test("spec setup appends project CLAUDE.md to generated CLAUDE.md", async ({
	page,
	server,
	sandbox,
}) => {
	test.setTimeout(120_000);

	await writeFile(join(sandbox.targetRepo, "CLAUDE.md"), PROJECT_CLAUDEMD, "utf8");

	const app = new AppPage(page);
	await app.goto(server.baseUrl);
	await app.waitConnected();

	await createSpecification(app, {
		specification: "Add a dark mode toggle to the application settings.",
		repo: sandbox.targetRepo,
	});

	const card = new WorkflowCardPage(page);
	await waitForStep(card, "setup", "completed", { timeoutMs: 60_000 });

	const worktreesDir = join(sandbox.targetRepo, ".worktrees");
	const worktrees = await readdir(worktreesDir);
	expect(worktrees.length).toBeGreaterThan(0);
	const claudePath = join(worktreesDir, worktrees[0], "CLAUDE.md");
	const content = await readFile(claudePath, "utf8");

	// Speckit prefix (from the uvx fake) must be byte-identical at the start.
	const speckitPrefix = "# Speckit-generated CLAUDE.md (litus-e2e-fake)\n";
	expect(content.startsWith(speckitPrefix)).toBe(true);

	// File must end with separator + project bytes.
	expect(content.endsWith(`${PROJECT_CLAUDEMD_SEPARATOR}${PROJECT_CLAUDEMD}`)).toBe(true);
});
