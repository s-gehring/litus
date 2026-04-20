import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getArtifactsRoot } from "../src/workflow-artifacts";
import { resetWorkflow } from "../src/workflow-engine";
import { makeWorkflow } from "./helpers";

const originalSpawn = Bun.spawn;
const BunGlobal = globalThis as unknown as { Bun: { spawn: unknown } };

function makeSpawnResult(exitCode: number, stderr = "") {
	return {
		exited: Promise.resolve(exitCode),
		stdout: new ReadableStream({
			start(c) {
				c.close();
			},
		}),
		stderr: new ReadableStream({
			start(c) {
				if (stderr) c.enqueue(new TextEncoder().encode(stderr));
				c.close();
			},
		}),
	};
}

function setMockSpawn(exitCode: number, stderr = "") {
	BunGlobal.Bun.spawn = (() => makeSpawnResult(exitCode, stderr)) as unknown;
}

/**
 * Per-git-subcommand dispatch: inspect `cmd[1]` ("worktree" or "branch") and
 * return the configured outcome. Lets one target fail while the others succeed.
 */
function setMockSpawnByCommand(byCommand: {
	worktree?: { code: number; stderr?: string };
	branch?: { code: number; stderr?: string };
}) {
	BunGlobal.Bun.spawn = ((cmd: string[]) => {
		const sub = cmd[1];
		const config =
			sub === "worktree" ? byCommand.worktree : sub === "branch" ? byCommand.branch : undefined;
		const code = config?.code ?? 0;
		const stderr = config?.stderr ?? "";
		return makeSpawnResult(code, stderr);
	}) as unknown;
}

describe("resetWorkflow", () => {
	const workflowId = `wf-reset-test-${Date.now()}`;
	const artifactsRoot = getArtifactsRoot(workflowId);

	beforeEach(() => {
		try {
			rmSync(artifactsRoot, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	afterEach(() => {
		BunGlobal.Bun.spawn = originalSpawn;
		try {
			rmSync(artifactsRoot, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test("happy path: returns to idle/step 0 with cleared step state", async () => {
		setMockSpawn(0);
		const wf = makeWorkflow({
			id: workflowId,
			status: "error",
			currentStepIndex: 3,
			worktreePath: "/tmp/some-path",
			worktreeBranch: "tmp-abc",
			targetRepository: "/tmp/repo",
			epicId: "epic-42",
		});
		wf.steps[0].output = "old output";
		wf.steps[0].status = "completed";
		wf.steps[1].error = "boom";
		wf.summary = "old summary";
		wf.stepSummary = "old step summary";
		wf.flavor = "old flavor";
		wf.activeWorkMs = 12345;
		wf.epicAnalysisMs = 6789;
		wf.feedbackEntries = [
			{
				id: "fb-1",
				iteration: 1,
				text: "old",
				submittedAt: new Date().toISOString(),
				submittedAtStepName: "merge-pr",
				outcome: null,
			},
		];

		const outcome = await resetWorkflow(wf);

		expect(outcome.partialFailure).toBe(false);
		expect(wf.status as string).toBe("idle");
		expect(wf.error).toBeNull();
		expect(wf.currentStepIndex).toBe(0);
		expect(wf.epicId).toBe("epic-42");
		expect(wf.id).toBe(workflowId);
		expect(wf.worktreePath).toBeNull();
		expect(wf.steps[0].output).toBe("");
		expect(wf.steps[0].status as string).toBe("pending");
		expect(wf.steps[1].error).toBeNull();
		expect(wf.summary).toBe("");
		expect(wf.stepSummary).toBe("");
		expect(wf.flavor).toBe("");
		expect(wf.activeWorkMs).toBe(0);
		expect(wf.epicAnalysisMs).toBe(0);
		expect(wf.feedbackEntries).toEqual([]);
	});

	test("idempotent: a second call still succeeds", async () => {
		setMockSpawn(0);
		const wf = makeWorkflow({
			id: workflowId,
			status: "error",
			worktreePath: "/tmp/some-path",
			targetRepository: "/tmp/repo",
		});
		await resetWorkflow(wf);
		wf.status = "error";
		const outcome = await resetWorkflow(wf);
		expect(outcome.partialFailure).toBe(false);
		expect(wf.status as string).toBe("idle");
	});

	test("partial failure: only worktree remove fails → message names worktree, not branch", async () => {
		// Per-command mock: worktree remove fails, branch delete succeeds. This
		// proves the failure message is targeted — a bug that accidentally
		// reported branch failure would fail this test.
		setMockSpawnByCommand({
			worktree: { code: 1, stderr: "fatal: permission denied" },
			branch: { code: 0 },
		});
		const wf = makeWorkflow({
			id: workflowId,
			status: "error",
			worktreePath: "/tmp/locked-worktree",
			worktreeBranch: "tmp-xyz",
			targetRepository: "/tmp/repo",
		});

		const outcome = await resetWorkflow(wf);
		expect(outcome.partialFailure).toBe(true);
		expect(outcome.worktree.ok).toBe(false);
		expect(outcome.branch.ok).toBe(true);
		expect(wf.status).toBe("error");
		expect(wf.error?.message).toContain("Reset failed: could not delete");
		expect(wf.error?.message).toContain("worktree /tmp/locked-worktree");
		expect(wf.error?.message).not.toContain("branch tmp-xyz");
		expect(wf.currentStepIndex).toBe(0);
		// The Setup step should not be flagged as errored — the reset failed,
		// not the Setup invocation. The workflow-level error.message is the
		// single source of truth. The assertions below guard against a
		// regression that re-introduces step-error mirroring: they would fail
		// if the reset-failure message were written back onto any step.error.
		expect(wf.steps[0].status).toBe("pending");
		expect(wf.steps[0].error).toBeNull();
		// Reset-failure text must live only on the workflow-level field — no
		// step's `.error` may carry a fragment of the message.
		const msg = wf.error?.message ?? "";
		for (const step of wf.steps) {
			expect(step.error).toBeNull();
			expect(step.error ?? "").not.toContain("Reset failed");
			expect(step.error ?? "").not.toContain(msg);
		}
	});

	test("partial failure: pre-existing step errors are cleared and NOT replaced with the reset message", async () => {
		// Seed every step with a distinctive pre-run error. After a partial-
		// failure reset, all step errors must be null (cleaned up) AND none of
		// them may carry any part of the new workflow-level reset-failure
		// message — a future regression that re-introduced mirroring at the
		// tail of resetWorkflow (after the cleanup loop) would fail here.
		setMockSpawnByCommand({
			worktree: { code: 1, stderr: "fatal: permission denied" },
			branch: { code: 0 },
		});
		const wf = makeWorkflow({
			id: workflowId,
			status: "error",
			worktreePath: "/tmp/locked-worktree",
			worktreeBranch: "tmp-xyz",
			targetRepository: "/tmp/repo",
		});
		for (const step of wf.steps) step.error = `prior run boom in ${step.name}`;

		await resetWorkflow(wf);

		expect(wf.error?.message).toContain("Reset failed");
		for (const step of wf.steps) {
			expect(step.error).toBeNull();
		}
	});

	test("already-missing worktree: exit-non-zero with 'is not a working tree' stderr counts as success (FR-008)", async () => {
		setMockSpawnByCommand({
			worktree: { code: 1, stderr: "fatal: '/tmp/gone' is not a working tree" },
			branch: { code: 0 },
		});
		const wf = makeWorkflow({
			id: workflowId,
			status: "error",
			worktreePath: "/tmp/gone",
			worktreeBranch: "tmp-abc",
			targetRepository: "/tmp/repo",
		});
		const outcome = await resetWorkflow(wf);
		expect(outcome.partialFailure).toBe(false);
		expect(outcome.worktree.ok).toBe(true);
		expect(wf.status as string).toBe("idle");
	});

	test("already-missing branch: exit-non-zero with 'not found' stderr counts as success (FR-008)", async () => {
		setMockSpawnByCommand({
			worktree: { code: 0 },
			branch: { code: 1, stderr: "error: branch 'tmp-gone' not found." },
		});
		const wf = makeWorkflow({
			id: workflowId,
			status: "error",
			worktreePath: "/tmp/some-path",
			worktreeBranch: "tmp-gone",
			targetRepository: "/tmp/repo",
		});
		const outcome = await resetWorkflow(wf);
		expect(outcome.partialFailure).toBe(false);
		expect(outcome.branch.ok).toBe(true);
		expect(wf.status as string).toBe("idle");
	});

	test("artifact files removed as part of reset", async () => {
		setMockSpawn(0);
		mkdirSync(join(artifactsRoot, "specify"), { recursive: true });
		writeFileSync(join(artifactsRoot, "specify", "spec.md"), "hi");
		const wf = makeWorkflow({
			id: workflowId,
			status: "aborted",
			worktreePath: null,
			targetRepository: "/tmp/repo",
		});
		const outcome = await resetWorkflow(wf);
		expect(outcome.artifacts.ok).toBe(true);
		if (outcome.artifacts.ok) {
			expect(outcome.artifacts.removed).toBe(1);
		}
	});
});
