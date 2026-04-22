import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CLICallbacks, CLIRunner } from "../../src/cli-runner";
import type { PipelineCallbacks } from "../../src/pipeline-orchestrator";
import { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type { EffortLevel, Workflow, WorkflowStatus } from "../../src/types";
import { getStepDefinitionsForKind, STEP } from "../../src/types";
import { WorkflowStore } from "../../src/workflow-store";

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "t@e.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "t@e.com",
};

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function run(cmd: string[], cwd: string): Promise<RunResult> {
	const p = Bun.spawn(cmd, {
		cwd,
		env: GIT_ENV,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const code = await p.exited;
	const stdout = await new Response(p.stdout as ReadableStream).text();
	const stderr = await new Response(p.stderr as ReadableStream).text();
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function mustRun(cmd: string[], cwd: string): Promise<RunResult> {
	const r = await run(cmd, cwd);
	if (r.code !== 0) throw new Error(`command failed (${cmd.join(" ")}): ${r.stderr || r.stdout}`);
	return r;
}

async function rmWithRetry(path: string): Promise<void> {
	for (let i = 0; i < 20; i++) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	rmSync(path, { recursive: true, force: true });
}

interface Fixture {
	origin: string;
	work: string;
	branch: string;
	cleanup: () => Promise<void>;
}

async function makeRepo(opts: {
	baseContent: string | null;
	branchCommitsExtra?: boolean;
}): Promise<Fixture> {
	const origin = mkdtempSync(join(tmpdir(), "int-guard-origin-"));
	const work = mkdtempSync(join(tmpdir(), "int-guard-work-"));
	const cleanup = async () => {
		await rmWithRetry(origin);
		await rmWithRetry(work);
	};
	try {
		await mustRun(["git", "init", "-b", "master"], origin);
		writeFileSync(join(origin, "seed.txt"), "seed");
		await mustRun(["git", "add", "."], origin);
		if (opts.baseContent !== null) {
			writeFileSync(join(origin, "CLAUDE.md"), opts.baseContent);
			await mustRun(["git", "add", "-f", "CLAUDE.md"], origin);
		}
		await mustRun(["git", "commit", "-m", "init"], origin);
		// allow pushing into the current branch of the origin (non-bare repo)
		await mustRun(["git", "config", "receive.denyCurrentBranch", "updateInstead"], origin);

		await mustRun(["git", "clone", origin, work], process.cwd());
		// The guard runs `git commit` via gitSpawn which does NOT forward
		// GIT_AUTHOR_* env vars, so local git identity must be configured on
		// the worktree for CI (where no global user.name/email exists).
		await mustRun(["git", "config", "user.email", "t@e.com"], work);
		await mustRun(["git", "config", "user.name", "Test"], work);
		const branch = "feat-guard";
		await mustRun(["git", "switch", "-c", branch], work);
		if (opts.branchCommitsExtra) {
			writeFileSync(join(work, "other.txt"), "hello");
			await mustRun(["git", "add", "other.txt"], work);
			await mustRun(["git", "commit", "-m", "feat: other"], work);
		}
		return { origin, work, branch, cleanup };
	} catch (err) {
		await cleanup();
		throw err;
	}
}

// Fake CLIRunner that captures prompts and lets the test drive completion.
interface CliInvocation {
	prompt: string;
	cwd: string;
	callbacks: CLICallbacks;
}

class FakeCliRunner {
	invocations: CliInvocation[] = [];
	onStart: ((inv: CliInvocation) => void | Promise<void>) | null = null;

	start(
		workflow: Workflow,
		callbacks: CLICallbacks,
		_extraEnv?: Record<string, string>,
		_model?: string,
		_effort?: EffortLevel,
	): void {
		const inv: CliInvocation = {
			prompt: workflow.specification,
			cwd: workflow.worktreePath ?? "",
			callbacks,
		};
		this.invocations.push(inv);
		queueMicrotask(async () => {
			if (this.onStart) await this.onStart(inv);
			callbacks.onOutput("agent finished\n");
			callbacks.onComplete();
		});
	}
	resume(): void {}
	kill(): void {}
	killAll(): void {}
}

function makeFakeEngine(workflow: Workflow) {
	return {
		getWorkflow: () => workflow,
		createWorkflow: async () => workflow,
		transition: (_id: string, status: WorkflowStatus) => {
			workflow.status = status;
		},
		setWorkflow: (_w: Workflow) => {},
		updateLastOutput: () => {},
		setQuestion: () => {},
		clearQuestion: () => {},
		updateSummary: () => {},
		updateStepSummary: () => {},
		createWorktree: async () => workflow.worktreePath ?? "",
		copyGitignoredFiles: async () => {},
		removeWorktree: async () => {},
		moveWorktree: async () => workflow.worktreePath ?? "",
	};
}

function makeWorkflow(worktreePath: string, branch: string): Workflow {
	const now = new Date().toISOString();
	return {
		id: "itest-guard",
		workflowKind: "spec",
		specification: "spec body",
		status: "running",
		targetRepository: worktreePath,
		worktreePath,
		worktreeBranch: branch,
		featureBranch: branch,
		summary: "",
		stepSummary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: getStepDefinitionsForKind("spec").map((def) => ({
			name: def.name,
			displayName: def.displayName,
			status: "pending" as const,
			prompt: def.prompt,
			sessionId: null,
			output: "",
			outputLog: [],
			error: null,
			startedAt: null,
			completedAt: null,
			pid: null,
			history: [],
		})),
		currentStepIndex: 0,
		reviewCycle: { iteration: 1, maxIterations: 3, lastSeverity: null },
		ciCycle: {
			attempt: 0,
			maxAttempts: 3,
			monitorStartedAt: null,
			globalTimeoutMs: 30 * 60 * 1000,
			lastCheckResults: [],
			failureLogs: [],
		},
		mergeCycle: { attempt: 0, maxAttempts: 3 },
		prUrl: null,
		epicId: null,
		epicTitle: null,
		epicDependencies: [],
		epicDependencyStatus: null,
		epicAnalysisMs: 0,
		activeWorkMs: 0,
		activeWorkStartedAt: null,
		feedbackEntries: [],
		feedbackPreRunHead: null,
		activeInvocation: null,
		managedRepo: null,
		error: null,
		createdAt: now,
		updatedAt: now,
		archived: false,
		archivedAt: null,
	};
}

async function commitCount(cwd: string): Promise<number> {
	const r = await mustRun(["git", "rev-list", "--count", "HEAD"], cwd);
	return parseInt(r.stdout.trim(), 10);
}

async function headFile(cwd: string, ref: string, path: string): Promise<string | null> {
	const r = await run(["git", "show", `${ref}:${path}`], cwd);
	return r.code === 0 ? r.stdout : null;
}

describe("pipeline commit-push-pr CLAUDE.md guard — integration", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "int-guard-store-"));
		store = new WorkflowStore(baseDir);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	interface Harness {
		orch: PipelineOrchestrator;
		fakeCli: FakeCliRunner;
		outputs: Array<{ workflowId: string; text: string }>;
		errors: Array<{ workflowId: string; text: string }>;
		pushed: Array<{ cwd: string; branch: string }>;
		prCreated: Array<{ cwd: string }>;
	}

	function makeOrch(workflow: Workflow, opts?: { ghExitCode?: number }): Harness {
		const outputs: Array<{ workflowId: string; text: string }> = [];
		const errors: Array<{ workflowId: string; text: string }> = [];
		const pushed: Array<{ cwd: string; branch: string }> = [];
		const prCreated: Array<{ cwd: string }> = [];
		const cb: PipelineCallbacks = {
			onStepChange: () => {},
			onOutput: (workflowId, text) => outputs.push({ workflowId, text }),
			onTools: () => {},
			onComplete: () => {},
			onError: (workflowId, text) => errors.push({ workflowId, text }),
			onStateChange: () => {},
		};
		const fakeCli = new FakeCliRunner();
		const orch = new PipelineOrchestrator(cb, {
			engine: makeFakeEngine(
				workflow,
			) as unknown as import("../../src/workflow-engine").WorkflowEngine,
			cliRunner: fakeCli as unknown as CLIRunner,
			workflowStore: store,
			ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
			gitPushFeatureBranch: async (cwd, branch) => {
				pushed.push({ cwd, branch });
				return { code: 0, stderr: "" };
			},
			ghPrCreate: async (cwd) => {
				prCreated.push({ cwd });
				if (opts?.ghExitCode && opts.ghExitCode !== 0) {
					return { code: opts.ghExitCode, stdout: "", stderr: "boom" };
				}
				return {
					code: 0,
					stdout: "https://github.com/acme/repo/pull/42\n",
					stderr: "",
				};
			},
		});
		return { orch, fakeCli, outputs, errors, pushed, prCreated };
	}

	async function until(predicate: () => boolean, opts: { timeoutMs?: number } = {}): Promise<void> {
		const timeoutMs = opts.timeoutMs ?? 30000;
		const start = Date.now();
		while (!predicate()) {
			if (Date.now() - start > timeoutMs) {
				throw new Error(`until: predicate did not hold within ${timeoutMs}ms`);
			}
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	function driveCommitPushPr(orch: PipelineOrchestrator, wf: Workflow): void {
		const idx = wf.steps.findIndex((s) => s.name === STEP.COMMIT_PUSH_PR);
		wf.currentStepIndex = idx;
		(orch as unknown as { startStep: (w: Workflow) => void }).startStep(wf);
	}

	test("assertion 1: no-delta happy path → no restore commit, push + pr invoked once, PR URL captured", async () => {
		const fx = await makeRepo({ baseContent: "x\n", branchCommitsExtra: true });
		try {
			const wf = makeWorkflow(fx.work, fx.branch);
			const h = makeOrch(wf);
			const before = await commitCount(fx.work);
			driveCommitPushPr(h.orch, wf);
			await until(() => h.pushed.length > 0 && h.prCreated.length > 0);
			await until(() => wf.prUrl !== null);

			expect(h.fakeCli.invocations.length).toBe(1);
			expect(h.pushed.length).toBe(1);
			expect(h.pushed[0].branch).toBe(fx.branch);
			expect(h.prCreated.length).toBe(1);
			expect(wf.prUrl).toBe("https://github.com/acme/repo/pull/42");

			// No chore: restore commit added
			expect(await commitCount(fx.work)).toBe(before);
			// Info line present
			expect(h.outputs.some((o) => o.text.includes("CLAUDE.md unchanged vs merge-base"))).toBe(
				true,
			);
		} finally {
			await fx.cleanup();
		}
	}, 60_000);

	test("assertion 2: agent modifies CLAUDE.md → guard adds chore: restore commit on tip", async () => {
		const fx = await makeRepo({ baseContent: "x\n" });
		try {
			const wf = makeWorkflow(fx.work, fx.branch);
			const h = makeOrch(wf);
			// Simulate the agent modifying + committing CLAUDE.md during Phase A.
			h.fakeCli.onStart = async () => {
				writeFileSync(join(fx.work, "CLAUDE.md"), "LOCAL-LEAK\n");
				await mustRun(["git", "add", "-f", "CLAUDE.md"], fx.work);
				await mustRun(["git", "commit", "-m", "agent: tweak"], fx.work);
			};
			driveCommitPushPr(h.orch, wf);
			await until(() => h.pushed.length > 0);

			// HEAD is chore: restore; HEAD^ is the agent's modified version.
			const headMsg = await mustRun(["git", "log", "-1", "--pretty=%s"], fx.work);
			expect(headMsg.stdout).toBe("chore: restore CLAUDE.md to pre-branch state");
			// `git show` output is trimmed by the test helper; compare trimmed.
			expect(await headFile(fx.work, "HEAD", "CLAUDE.md")).toBe("x");
			expect(await headFile(fx.work, "HEAD^", "CLAUDE.md")).toBe("LOCAL-LEAK");
			// Working tree reflects the merge-base content (normalize CRLF for Windows).
			const wt = readFileSync(join(fx.work, "CLAUDE.md"), "utf-8").replace(/\r\n/g, "\n");
			expect(wt).toBe("x\n");
			expect(h.pushed.length).toBe(1);
		} finally {
			await fx.cleanup();
		}
	}, 60_000);

	test("assertion 3: main-has-no-file; branch added one → guard git-rm's the file", async () => {
		const fx = await makeRepo({ baseContent: null });
		try {
			const wf = makeWorkflow(fx.work, fx.branch);
			const h = makeOrch(wf);
			h.fakeCli.onStart = async () => {
				writeFileSync(join(fx.work, "CLAUDE.md"), "local\n");
				await mustRun(["git", "add", "-f", "CLAUDE.md"], fx.work);
				await mustRun(["git", "commit", "-m", "agent: add claude"], fx.work);
			};
			driveCommitPushPr(h.orch, wf);
			await until(() => h.pushed.length > 0);

			expect(existsSync(join(fx.work, "CLAUDE.md"))).toBe(false);
			expect(await headFile(fx.work, "HEAD", "CLAUDE.md")).toBeNull();
		} finally {
			await fx.cleanup();
		}
	}, 60_000);

	test("assertion 4: unchanged on repo whose main has no CLAUDE.md → no restore, push proceeds", async () => {
		const fx = await makeRepo({ baseContent: null, branchCommitsExtra: true });
		try {
			const wf = makeWorkflow(fx.work, fx.branch);
			const h = makeOrch(wf);
			const before = await commitCount(fx.work);
			driveCommitPushPr(h.orch, wf);
			await until(() => h.pushed.length > 0);
			expect(await commitCount(fx.work)).toBe(before);
			expect(h.pushed.length).toBe(1);
		} finally {
			await fx.cleanup();
		}
	}, 60_000);

	test("assertion 5: guard throws (pre-commit hook blocks restore) → no push, workflow errors, prUrl stays null", async () => {
		const fx = await makeRepo({ baseContent: "x\n" });
		try {
			// Install a failing pre-commit hook that blocks the guard's commit.
			const hookPath = join(fx.work, ".git", "hooks", "pre-commit");
			writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
			try {
				chmodSync(hookPath, 0o755);
			} catch {}

			const wf = makeWorkflow(fx.work, fx.branch);
			const h = makeOrch(wf);
			h.fakeCli.onStart = async () => {
				writeFileSync(join(fx.work, "CLAUDE.md"), "LOCAL-LEAK\n");
				await mustRun(["git", "add", "-f", "CLAUDE.md"], fx.work);
				await mustRun(["git", "commit", "--no-verify", "-m", "agent: tweak"], fx.work);
			};
			driveCommitPushPr(h.orch, wf);
			await until(() => h.errors.length > 0);

			expect(h.pushed.length).toBe(0);
			expect(h.prCreated.length).toBe(0);
			expect(wf.prUrl).toBeNull();
			expect(h.errors[0].text).toMatch(/claude-md-guard: commit failed/);
		} finally {
			await fx.cleanup();
		}
	}, 60_000);

	test("assertion 7: disjoint histories → warn line emitted, push + PR still proceed", async () => {
		// Build a feature worktree that has no shared ancestor with origin/master.
		const origin = mkdtempSync(join(tmpdir(), "int-guard-origin-"));
		const work = mkdtempSync(join(tmpdir(), "int-guard-work-"));
		const cleanup = async () => {
			await rmWithRetry(origin);
			await rmWithRetry(work);
		};
		try {
			await mustRun(["git", "init", "-b", "master"], origin);
			writeFileSync(join(origin, "seed.txt"), "origin-seed");
			await mustRun(["git", "add", "."], origin);
			await mustRun(["git", "commit", "-m", "init"], origin);
			await mustRun(["git", "config", "receive.denyCurrentBranch", "updateInstead"], origin);

			// work is an independent repo; origin is added as a remote but shares
			// no ancestry with work's HEAD.
			await mustRun(["git", "init", "-b", "master"], work);
			await mustRun(["git", "config", "user.email", "t@e.com"], work);
			await mustRun(["git", "config", "user.name", "Test"], work);
			writeFileSync(join(work, "other.txt"), "other");
			await mustRun(["git", "add", "."], work);
			await mustRun(["git", "commit", "-m", "independent"], work);
			await mustRun(["git", "remote", "add", "origin", origin], work);
			await mustRun(["git", "fetch", "origin"], work);
			const branch = "feat-guard-disjoint";
			await mustRun(["git", "switch", "-c", branch], work);

			const wf = makeWorkflow(work, branch);
			const h = makeOrch(wf);
			const before = await commitCount(work);
			driveCommitPushPr(h.orch, wf);
			await until(() => h.pushed.length > 0 && h.prCreated.length > 0);

			expect(h.outputs.some((o) => o.text.includes("No merge-base with origin/master"))).toBe(true);
			// No restore commit — HEAD is unchanged.
			expect(await commitCount(work)).toBe(before);
			expect(h.pushed.length).toBe(1);
			expect(h.prCreated.length).toBe(1);
		} finally {
			await cleanup();
		}
	}, 60_000);

	test("assertion 6: agent prompt payload does not embed the CLAUDE.md contract header", async () => {
		// The contract header moved from the user prompt to CLIRunner's
		// --append-system-prompt flag (see tests/cli-runner.test.ts). Embedding it
		// in the user prompt pushed slash-command step prompts off the first
		// character and broke Claude Code's `-p` slash-command interception.
		const fx = await makeRepo({ baseContent: "x\n", branchCommitsExtra: true });
		try {
			const wf = makeWorkflow(fx.work, fx.branch);
			const h = makeOrch(wf);
			driveCommitPushPr(h.orch, wf);
			await until(() => h.fakeCli.invocations.length > 0);

			const prompt = h.fakeCli.invocations[0].prompt;
			expect(prompt).not.toContain("CLAUDE.md is Litus-managed local context");
		} finally {
			await fx.cleanup();
		}
	}, 60_000);
});
