import { promptOf, readCapturedClaudeCalls } from "../harness/claude-captures";
import { expect, test } from "../harness/fixtures";
import { mergePullRequest, waitForStep } from "../helpers";
import { AppPage, QuickFixFormPage, WorkflowCardPage } from "../pages";

/**
 * Regression: every user-supplied LLM input (specification, epic description,
 * quick-fix description, question, feedback) must travel from the WS handler
 * to the Claude CLI via stdin — never as a positional `-p <text>` argv entry.
 * The OS argv length cap is well under our user-input cap (300_000 chars), so
 * a long quick-fix description used to surface as an opaque "spawn failed"
 * before the input ever reached the model.
 *
 * This test submits a quick-fix description ~250k chars long (clearly above
 * Linux's 128KB per-arg cap and Windows' 32KB cmd cap) and asserts:
 *   - the workflow completes the fix-implement step end-to-end (proves the
 *     CLI bridge accepted the input — stdin works)
 *   - the captured invocation has no positional prompt in argv
 *   - the captured stdin matches the full submitted description verbatim
 *
 * Without the stdin pipe, this would fail at process spawn long before the
 * scripted scenario response could be returned.
 */
test.use({ scenarioName: "quick-fix-large-input", autoMode: "manual" });

// 250_000 chars — comfortably above the per-arg argv caps on every supported
// OS, and below the 300_000-char user-input cap so the validator accepts it.
const LARGE_DESCRIPTION = `Fix typo in the greeting helper. ${"x".repeat(250_000)}`;

test("quick-fix accepts a 250k-char description and pipes it via stdin (not argv)", async ({
	page,
	server,
	sandbox,
}) => {
	test.setTimeout(360_000);

	const app = new AppPage(page);
	await app.goto(server.baseUrl);
	await app.waitConnected();

	// Open the quick-fix modal and fill the description directly via DOM —
	// `fill()` re-uses keystroke simulation, which is workable but slow at this
	// size. Set the value and dispatch an `input` event so the form's enable
	// logic recomputes.
	await app.quickFixButton().click();
	const form = new QuickFixFormPage(page);
	await expect(form.modal()).toBeVisible();
	await form.repoInput().fill(sandbox.targetRepo);

	const descriptionLocator = form.descriptionInput();
	await descriptionLocator.evaluate((el, value) => {
		const textarea = el as HTMLTextAreaElement;
		textarea.value = value;
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	}, LARGE_DESCRIPTION);

	await expect(form.submitButton()).toBeEnabled();
	await form.submitButton().click();
	await expect(form.modal()).toBeHidden({ timeout: 30_000 });

	const card = new WorkflowCardPage(page);
	await waitForStep(card, "setup", "completed", { timeoutMs: 60_000 });
	// Reaching `fix-implement = completed` is the end-to-end proof that the
	// 250k-char description survived the spawn — argv-mode would have errored
	// out at process creation, never running the scripted response.
	await waitForStep(card, "fix-implement", "completed", { timeoutMs: 60_000 });
	await waitForStep(card, "commit-push-pr", "completed", { timeoutMs: 60_000 });
	await waitForStep(card, "monitor-ci", "completed", { timeoutMs: 60_000 });

	await expect(card.prLink()).toBeVisible();
	await mergePullRequest(card);
	await waitForStep(card, "merge-pr", "completed", { timeoutMs: 60_000 });

	// Inspect the recorded fake-claude invocations: the first scripted call
	// (fix-implement) must carry the full description in stdin and must NOT
	// embed it as a positional `-p <text>` argv entry.
	const calls = readCapturedClaudeCalls(sandbox.counterFile);
	expect(calls.length).toBeGreaterThanOrEqual(1);
	const fixImplementCall = calls[0];

	// argv must contain the `-p` flag (Claude needs print-mode) but not the
	// prompt text — that channel is reserved for stdin now.
	expect(fixImplementCall.argv).toContain("-p");
	const pIdx = fixImplementCall.argv.indexOf("-p");
	const afterP = fixImplementCall.argv[pIdx + 1] ?? "";
	expect(afterP.startsWith("-")).toBe(true);
	expect(fixImplementCall.argv.join("\n")).not.toContain(LARGE_DESCRIPTION);

	// The stdin capture must contain the full submitted description verbatim.
	// `promptOf` resolves to stdin first, falling back to the legacy `-p`
	// positional form — assert directly on `.stdin` so a regression that
	// reverts to argv would fail loudly here rather than silently passing
	// through the fallback.
	expect(fixImplementCall.stdin.length).toBeGreaterThanOrEqual(LARGE_DESCRIPTION.length);
	expect(fixImplementCall.stdin).toContain(LARGE_DESCRIPTION);
	expect(promptOf(fixImplementCall)).toContain(LARGE_DESCRIPTION);
});
