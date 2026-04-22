import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config-store";
import {
	buildFeedbackPrompt,
	buildPriorOutcomesSection,
	detectNewCommits,
	parseAgentResult,
	reconcileOutcome,
} from "../src/feedback-implementer";
import type { AppConfig, FeedbackEntry, WorkflowStatus } from "../src/types";
import { makeWorkflow } from "./helpers";

function cloneConfig(): AppConfig {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
}

function entry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
	return {
		id: overrides.id ?? "fe-1",
		iteration: overrides.iteration ?? 1,
		text: overrides.text ?? "rename x to count",
		submittedAt: overrides.submittedAt ?? "2026-04-13T14:22:01.000Z",
		submittedAtStepName: overrides.submittedAtStepName ?? "merge-pr",
		outcome: overrides.outcome === undefined ? null : overrides.outcome,
	};
}

describe("buildFeedbackPrompt", () => {
	test("interpolates all four placeholders", () => {
		const cfg = cloneConfig();
		cfg.prompts.feedbackImplementerInstruction =
			"FC=[${feedbackContext}] PO=[${priorOutcomes}] LATEST=[${latestFeedbackText}] PR=[${prUrl}]";

		const wf = makeWorkflow();
		wf.feedbackEntries = [
			entry({
				iteration: 1,
				text: "rename x to count",
				outcome: {
					value: "success",
					summary: "renamed x to count",
					commitRefs: ["abc1234"],
					warnings: [],
				},
			}),
		];

		const prompt = buildFeedbackPrompt(
			cfg,
			wf,
			"second feedback text",
			"https://github.com/owner/repo/pull/42",
		);

		expect(prompt).toContain("LATEST=[second feedback text]");
		expect(prompt).toContain("PR=[https://github.com/owner/repo/pull/42]");
		expect(prompt).toContain("USER FEEDBACK");
		expect(prompt).toContain("Prior feedback-implementer outcome records");
		expect(prompt).toContain("rename x to count");
	});

	test("default template does not embed the CLAUDE.md contract header", () => {
		// The header is delivered via --append-system-prompt by CLIRunner, not
		// embedded in the default user-prompt template.
		const cfg = cloneConfig();
		const wf = makeWorkflow();

		const prompt = buildFeedbackPrompt(cfg, wf, "apply this", "https://pr");
		expect(prompt).not.toContain("CLAUDE.md is Litus-managed local context");
	});

	test("empty feedbackEntries produces empty feedbackContext and priorOutcomes", () => {
		const cfg = cloneConfig();
		cfg.prompts.feedbackImplementerInstruction =
			"FC=[${feedbackContext}] PO=[${priorOutcomes}] LATEST=[${latestFeedbackText}]";

		const wf = makeWorkflow();
		const prompt = buildFeedbackPrompt(cfg, wf, "first feedback", "https://pr");

		expect(prompt).toContain("FC=[]");
		expect(prompt).toContain("PO=[]");
		expect(prompt).toContain("LATEST=[first feedback]");
	});
});

describe("buildPriorOutcomesSection", () => {
	test("lists only completed entries with summary and commit refs", () => {
		const wf = makeWorkflow();
		wf.feedbackEntries = [
			entry({
				iteration: 1,
				text: "done",
				outcome: {
					value: "success",
					summary: "first change",
					commitRefs: ["abc", "def"],
					warnings: [],
				},
			}),
			entry({
				id: "fe-2",
				iteration: 2,
				text: "skipped",
				outcome: {
					value: "no changes",
					summary: "already done",
					commitRefs: [],
					warnings: [],
				},
			}),
			entry({
				id: "fe-3",
				iteration: 3,
				text: "in flight",
				outcome: null,
			}),
		];

		const section = buildPriorOutcomesSection(wf);
		expect(section).toContain("Iteration 1 (success)");
		expect(section).toContain("first change");
		expect(section).toContain("abc, def");
		expect(section).toContain("Iteration 2 (no changes)");
		expect(section).toContain("(no commits)");
		expect(section).not.toContain("Iteration 3");
	});

	test("returns empty string when no completed entries", () => {
		const wf = makeWorkflow();
		expect(buildPriorOutcomesSection(wf)).toBe("");
	});
});

describe("parseAgentResult", () => {
	test("extracts shape from a single sentinel block", () => {
		const output = `Some preamble
<<<FEEDBACK_IMPLEMENTER_RESULT
{
  "outcome": "success",
  "summary": "renamed x to count",
  "materiallyRelevant": true,
  "prDescriptionUpdate": { "attempted": true, "succeeded": true, "errorMessage": null }
}
FEEDBACK_IMPLEMENTER_RESULT>>>`;

		const parsed = parseAgentResult(output);
		expect(parsed.sentinelFound).toBe(true);
		expect(parsed.outcome).toBe("success");
		expect(parsed.summary).toBe("renamed x to count");
		expect(parsed.materiallyRelevant).toBe(true);
		expect(parsed.prDescriptionUpdate).toEqual({
			attempted: true,
			succeeded: true,
			errorMessage: null,
		});
	});

	test("uses the last sentinel block when multiple are present", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"failed","summary":"first","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>

Later...
<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"second","materiallyRelevant":true}
FEEDBACK_IMPLEMENTER_RESULT>>>`;

		const parsed = parseAgentResult(output);
		expect(parsed.outcome).toBe("success");
		expect(parsed.summary).toBe("second");
	});

	test("returns sentinelFound=false when no sentinel present", () => {
		const parsed = parseAgentResult("no sentinel anywhere in this output");
		expect(parsed.sentinelFound).toBe(false);
		expect(parsed.outcome).toBeNull();
		expect(parsed.summary).toBe("");
	});

	test("returns sentinelFound=false when sentinel JSON is unparseable", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
not valid json {{{
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		expect(parsed.sentinelFound).toBe(false);
	});

	test("treats missing prDescriptionUpdate as null", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"no changes","summary":"noop","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		expect(parsed.prDescriptionUpdate).toBeNull();
	});

	test("parses prDescriptionUpdate with failure (succeeded: false + errorMessage)", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"pushed","materiallyRelevant":true,"prDescriptionUpdate":{"attempted":true,"succeeded":false,"errorMessage":"gh: rate limited"}}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		expect(parsed.prDescriptionUpdate).toEqual({
			attempted: true,
			succeeded: false,
			errorMessage: "gh: rate limited",
		});
	});

	test("rejects prDescriptionUpdate when attempted is not boolean", () => {
		const outputs = [
			`<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"","materiallyRelevant":false,"prDescriptionUpdate":{"attempted":"true","succeeded":true}}
FEEDBACK_IMPLEMENTER_RESULT>>>`,
			`<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"","materiallyRelevant":false,"prDescriptionUpdate":{"attempted":null,"succeeded":true}}
FEEDBACK_IMPLEMENTER_RESULT>>>`,
			`<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"","materiallyRelevant":false,"prDescriptionUpdate":"not an object"}
FEEDBACK_IMPLEMENTER_RESULT>>>`,
		];
		for (const output of outputs) {
			const parsed = parseAgentResult(output);
			expect(parsed.sentinelFound).toBe(true);
			expect(parsed.prDescriptionUpdate).toBeNull();
		}
	});

	test("coerces non-string errorMessage to null", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"","materiallyRelevant":true,"prDescriptionUpdate":{"attempted":true,"succeeded":false,"errorMessage":42}}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		expect(parsed.prDescriptionUpdate?.errorMessage).toBeNull();
	});

	test("unrecognized outcome string falls back to outcome=null (review-3 §1.4/§3.3)", () => {
		// A typo like "succeeded" (not "success") or any other unknown string
		// must not silently map to a known outcome. The caller (reconcileOutcome)
		// then picks based on commits + cliFailed; the orchestrator additionally
		// emits a logger.warn so the mis-customisation is diagnosable.
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"succeeded","summary":"typo","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		expect(parsed.sentinelFound).toBe(true);
		expect(parsed.outcome).toBeNull();
		expect(parsed.summary).toBe("typo");
	});

	test("non-string outcome value falls back to outcome=null (review-3 §1.4/§3.3)", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":42,"summary":"wrong type","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		expect(parsed.sentinelFound).toBe(true);
		expect(parsed.outcome).toBeNull();
	});

	test("missing outcome field falls back to outcome=null (review-3 §1.4/§3.3)", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"summary":"no outcome key","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		expect(parsed.sentinelFound).toBe(true);
		expect(parsed.outcome).toBeNull();
	});
});

describe("reconcileOutcome", () => {
	test("commits present → success regardless of sentinel", () => {
		const parsed = parseAgentResult("");
		const o = reconcileOutcome(parsed, ["abc123"], false);
		expect(o.value).toBe("success");
		expect(o.commitRefs).toEqual(["abc123"]);
		expect(o.warnings).toEqual([]);
	});

	test("no commits + cliFailed → failed", () => {
		const parsed = parseAgentResult("");
		const o = reconcileOutcome(parsed, [], true);
		expect(o.value).toBe("failed");
		expect(o.commitRefs).toEqual([]);
	});

	test("no commits + no cli failure → no changes", () => {
		const parsed = parseAgentResult("");
		const o = reconcileOutcome(parsed, [], false);
		expect(o.value).toBe("no changes");
	});

	test("commits + prDescriptionUpdate failure → success with warning", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"renamed","materiallyRelevant":true,"prDescriptionUpdate":{"attempted":true,"succeeded":false,"errorMessage":"gh failed"}}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		const o = reconcileOutcome(parsed, ["abc"], false);
		expect(o.value).toBe("success");
		expect(o.warnings).toHaveLength(1);
		expect(o.warnings[0].kind).toBe("pr_description_update_failed");
		expect(o.warnings[0].message).toContain("gh failed");
	});

	test("commits + prDescriptionUpdate attempted+succeeded → success with no warnings", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"done","materiallyRelevant":true,"prDescriptionUpdate":{"attempted":true,"succeeded":true,"errorMessage":null}}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		const o = reconcileOutcome(parsed, ["abc"], false);
		expect(o.value).toBe("success");
		expect(o.warnings).toEqual([]);
	});

	test("materiallyRelevant: false with no PR update → success with no warnings", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"internal rename","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		const o = reconcileOutcome(parsed, ["abc"], false);
		expect(o.value).toBe("success");
		expect(o.warnings).toEqual([]);
	});

	test("agent-reported outcome=failed with no commits and no CLI failure yields failed", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"failed","summary":"I couldn't do the thing","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		const o = reconcileOutcome(parsed, [], false);
		expect(o.value).toBe("failed");
		expect(o.summary).toBe("I couldn't do the thing");
	});

	test("agent-reported outcome=no changes is preserved when no commits and no CLI failure", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"no changes","summary":"already done","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		const o = reconcileOutcome(parsed, [], false);
		expect(o.value).toBe("no changes");
	});

	test("commits present override agent-reported failed (git is authoritative for commits)", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"failed","summary":"I crashed","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		const o = reconcileOutcome(parsed, ["abc123"], false);
		expect(o.value).toBe("success");
		expect(o.commitRefs).toEqual(["abc123"]);
	});

	test("PR-edit failure without commits preserves warning on no-changes outcome", () => {
		const output = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"no changes","summary":"nothing to commit","materiallyRelevant":true,"prDescriptionUpdate":{"attempted":true,"succeeded":false,"errorMessage":"gh failed"}}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		const parsed = parseAgentResult(output);
		const o = reconcileOutcome(parsed, [], false);
		expect(o.value).toBe("no changes");
		expect(o.warnings).toHaveLength(1);
		expect(o.warnings[0].kind).toBe("pr_description_update_failed");
		expect(o.warnings[0].message).toContain("gh failed");
	});
});

describe("detectNewCommits", () => {
	let repoDir: string;

	beforeEach(() => {
		repoDir = join(
			tmpdir(),
			`feedback-impl-git-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(repoDir, { recursive: true });
		spawnSync("git", ["init", "-q", "-b", "master"], { cwd: repoDir });
		spawnSync("git", ["config", "user.email", "test@test"], { cwd: repoDir });
		spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
		writeFileSync(join(repoDir, "a.txt"), "a\n");
		spawnSync("git", ["add", "."], { cwd: repoDir });
		spawnSync("git", ["commit", "-qm", "initial"], { cwd: repoDir });
	});

	afterEach(() => {
		try {
			rmSync(repoDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	test("returns empty array when HEAD hasn't advanced", async () => {
		const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
		const head = headResult.stdout.toString().trim();
		const commits = await detectNewCommits(head, repoDir);
		expect(commits).toEqual([]);
	});

	test("returns new commit SHAs in chronological order", async () => {
		const baseResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
		const base = baseResult.stdout.toString().trim();

		writeFileSync(join(repoDir, "b.txt"), "b\n");
		spawnSync("git", ["add", "."], { cwd: repoDir });
		spawnSync("git", ["commit", "-qm", "add b"], { cwd: repoDir });
		const firstNew = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir })
			.stdout.toString()
			.trim();

		writeFileSync(join(repoDir, "c.txt"), "c\n");
		spawnSync("git", ["add", "."], { cwd: repoDir });
		spawnSync("git", ["commit", "-qm", "add c"], { cwd: repoDir });
		const secondNew = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir })
			.stdout.toString()
			.trim();

		const commits = await detectNewCommits(base, repoDir);
		expect(commits).toEqual([firstNew, secondNew]);
	});

	test("returns empty array on empty preRunHead", async () => {
		const commits = await detectNewCommits("", repoDir);
		expect(commits).toEqual([]);
	});

	test("returns empty array when preRunHead is invalid", async () => {
		const commits = await detectNewCommits("0000000000000000000000000000000000000000", repoDir);
		expect(commits).toEqual([]);
	});

	test("returns empty array when cwd does not exist (gitSpawn throws)", async () => {
		// Exercise the try/catch: Bun.spawn rejects for a non-existent cwd.
		// The helper must swallow the error and return [].
		const bogusCwd = join(
			tmpdir(),
			`feedback-impl-bogus-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const commits = await detectNewCommits("abc123", bogusCwd);
		expect(commits).toEqual([]);
	});
});

describe("recoverInterruptedFeedbackImplementer corner cases", () => {
	async function importRecover() {
		const { recoverInterruptedFeedbackImplementer } = await import("../src/feedback-implementer");
		return recoverInterruptedFeedbackImplementer;
	}

	test("does not corrupt an outcome that is already set on the latest entry", async () => {
		const recover = await importRecover();
		const wf = makeWorkflow();
		wf.feedbackEntries = [
			entry({
				iteration: 1,
				text: "earlier iteration",
				outcome: {
					value: "success",
					summary: "done already",
					commitRefs: ["sha-done"],
					warnings: [],
				},
			}),
		];
		const fiIdx = wf.steps.findIndex((s) => s.name === "feedback-implementer");
		wf.currentStepIndex = fiIdx;
		wf.steps[fiIdx].status = "running";

		recover(wf);

		// Outcome preserved — only null outcomes are mutated.
		const latest = wf.feedbackEntries[wf.feedbackEntries.length - 1];
		expect(latest.outcome?.value).toBe("success");
		expect(latest.outcome?.summary).toBe("done already");
		// Workflow is still rewound to merge-pr pause even when no in-flight entry
		// needed aborting — this is the FR-020 contract.
		const mergeIdx = wf.steps.findIndex((s) => s.name === "merge-pr");
		expect(wf.currentStepIndex).toBe(mergeIdx);
		expect(wf.status).toBe("paused");
	});

	test("handles workflows missing the feedback-implementer step (stale schema)", async () => {
		const recover = await importRecover();
		const wf = makeWorkflow();
		wf.steps = wf.steps.filter((s) => s.name !== "feedback-implementer");
		wf.feedbackEntries = [entry({ iteration: 1, text: "in flight", outcome: null })];
		wf.status = "running" as WorkflowStatus;

		// Must not throw even when the FI step is absent.
		expect(() => recover(wf)).not.toThrow();

		const latest = wf.feedbackEntries[wf.feedbackEntries.length - 1];
		expect(latest.outcome?.value).toBe("aborted");
		expect(wf.status).toBe("paused");
	});

	test("handles workflows missing the merge-pr step", async () => {
		const recover = await importRecover();
		const wf = makeWorkflow();
		wf.steps = wf.steps.filter((s) => s.name !== "merge-pr");
		wf.feedbackEntries = [entry({ iteration: 1, text: "in flight", outcome: null })];
		wf.status = "running" as WorkflowStatus;

		expect(() => recover(wf)).not.toThrow();
		// Workflow status still falls back to paused even if the rewind target is
		// missing — the status-last convention ensures a safe terminal state.
		expect(wf.status).toBe("paused");
	});

	test("clears feedbackPreRunHead so the next iteration starts fresh", async () => {
		const recover = await importRecover();
		const wf = makeWorkflow();
		wf.feedbackPreRunHead = "interrupted-head-sha";
		wf.feedbackEntries = [entry({ iteration: 1, text: "interrupted", outcome: null })];
		wf.status = "running" as WorkflowStatus;

		recover(wf);

		expect(wf.feedbackPreRunHead).toBeNull();
	});
});
