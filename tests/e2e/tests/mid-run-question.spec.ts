import { promptOf, readCapturedClaudeCalls } from "../harness/claude-captures";
import { expect, test } from "../harness/fixtures";
import { answerClarifyingQuestion, createSpecification, waitForStep } from "../helpers";
import { AppPage, QuestionPromptPage, WorkflowCardPage } from "../pages";

test.describe("US2: mid-run question handling", () => {
	test.use({ scenarioName: "mid-run-question" });

	test.describe("manual mode", () => {
		test.use({ autoMode: "manual" });

		test("panel renders, answer advances the pipeline", async ({ page, server, sandbox }) => {
			test.setTimeout(120_000);
			const app = new AppPage(page);
			await app.goto(server.baseUrl);
			await app.waitConnected();

			await createSpecification(app, {
				specification: "Add a dark mode toggle to the application settings.",
				repo: sandbox.targetRepo,
			});

			const card = new WorkflowCardPage(page);
			await waitForStep(card, "clarify", "waiting", { timeoutMs: 60_000 });

			const prompt = new QuestionPromptPage(page);
			await expect(prompt.panel()).toBeVisible({ timeout: 10_000 });
			await expect(prompt.questionContent()).toContainText("dark mode");

			await answerClarifyingQuestion(card, "yes", {
				expectQuestionContains: "dark mode",
			});

			await waitForStep(card, "clarify", "completed", { timeoutMs: 60_000 });
			await waitForStep(card, "plan", "completed", { timeoutMs: 60_000 });

			// The resume call that carries the operator answer spawns claude with
			// `--resume <sessionId>` plus a non-empty `-p` prompt. The session id
			// for clarify-2 is scripted in the scenario and is a stable marker.
			const calls = readCapturedClaudeCalls(sandbox.counterFile);
			const resumeCall = calls.find(
				(c) =>
					c.argv.includes("--resume") &&
					c.argv.includes("sess-clarify") &&
					c.outputFormat === "stream-json",
			);
			expect(resumeCall, "expected a resume call using the clarify session").toBeDefined();
			const resumePrompt = promptOf(resumeCall!);
			expect(resumePrompt, "resume prompt should be non-empty").not.toBeNull();
			expect(resumePrompt!.length).toBeGreaterThan(0);
		});
	});

	test.describe("full-auto mode", () => {
		test.use({ autoMode: "full-auto" });

		test("auto-answer fires without panel interaction", async ({ page, server, sandbox }) => {
			test.setTimeout(120_000);
			const app = new AppPage(page);
			await app.goto(server.baseUrl);
			await app.waitConnected();

			await createSpecification(app, {
				specification: "Add a dark mode toggle to the application settings.",
				repo: sandbox.targetRepo,
			});

			const card = new WorkflowCardPage(page);

			// Full Auto short-circuits the question panel — we must never observe
			// a visible panel during this run. Wait past clarify to confirm.
			await waitForStep(card, "clarify", "completed", { timeoutMs: 60_000 });

			const prompt = new QuestionPromptPage(page);
			await expect(prompt.panel()).toBeHidden();

			// Full-auto path produces a resume call with a non-empty answer in
			// the `-p` prompt. Exact text is owned by product code and not
			// pinned (per spec US2 §3).
			const calls = readCapturedClaudeCalls(sandbox.counterFile);
			const resumeCall = calls.find(
				(c) =>
					c.argv.includes("--resume") &&
					c.argv.includes("sess-clarify") &&
					c.outputFormat === "stream-json",
			);
			expect(resumeCall, "expected an auto-resume call using the clarify session").toBeDefined();
			const resumePrompt = promptOf(resumeCall!);
			expect(resumePrompt, "auto-resume prompt should be non-empty").not.toBeNull();
			expect(resumePrompt!.length).toBeGreaterThan(0);
		});
	});
});
