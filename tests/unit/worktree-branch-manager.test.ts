import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workflow } from "../../src/types";
import { WorkflowEngine } from "../../src/workflow-engine";
import { WorktreeBranchManager } from "../../src/worktree-branch-manager";

/**
 * FR-010 / SC-002: every test in this file MUST construct a
 * `WorktreeBranchManager` directly — no `PipelineOrchestrator`. The whole point
 * of the manager extraction is that worktree behaviour is unit-testable in
 * isolation.
 */

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
	const now = new Date().toISOString();
	const base: Workflow = {
		id: "wf-test",
		workflowKind: "quick-fix",
		specification: "fix the thing",
		status: "running",
		targetRepository: "/tmp/repo",
		worktreePath: null,
		worktreeBranch: "tmp-abcd1234",
		featureBranch: null,
		summary: "",
		stepSummary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: [],
		currentStepIndex: 0,
		prUrl: null,
		reviewCycle: { iteration: 1, maxIterations: 3, lastSeverity: null },
		ciCycle: {
			attempt: 0,
			maxAttempts: 5,
			monitorStartedAt: null,
			globalTimeoutMs: 60_000,
			lastCheckResults: [],
			failureLogs: [],
			userFixGuidance: null,
		},
		mergeCycle: { attempt: 0, maxAttempts: 3 },
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
		hasEverStarted: false,
		createdAt: now,
		updatedAt: now,
		archived: false,
		archivedAt: null,
	};
	return { ...base, ...overrides };
}

function fakeEngine(): WorkflowEngine {
	return new WorkflowEngine();
}

function makeRealRepo(): {
	repo: string;
	worktree: string;
	cleanup: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "wbm-test-"));
	const repo = join(root, "repo");
	const worktree = join(root, "worktree");
	execSync(`git init --initial-branch=master "${repo}"`, { stdio: "ignore" });
	execSync(`git -C "${repo}" config user.email "t@t"`, { stdio: "ignore" });
	execSync(`git -C "${repo}" config user.name "t"`, { stdio: "ignore" });
	writeFileSync(join(repo, "README.md"), "x\n");
	execSync(`git -C "${repo}" add . && git -C "${repo}" commit -m init`, { stdio: "ignore" });
	execSync(`git -C "${repo}" worktree add --detach "${worktree}"`, { stdio: "ignore" });
	return {
		repo,
		worktree,
		cleanup: () => {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("WorktreeBranchManager", () => {
	test("initQuickFixBranch generates a fix branch name and mutates featureBranch + worktreeBranch", async () => {
		const fx = makeRealRepo();
		try {
			const manager = new WorktreeBranchManager(fakeEngine());
			const wf = makeWorkflow({
				workflowKind: "quick-fix",
				specification: "fix login bug",
				worktreePath: fx.worktree,
				targetRepository: fx.repo,
			});

			const result = await manager.initQuickFixBranch(wf);
			if (!("ok" in result) || !result.ok) throw new Error("unreachable");
			expect(result.data.branchName).toMatch(/^fix\/\d{3,}-/);
			expect(wf.featureBranch).toBe(result.data.branchName);
			expect(wf.worktreeBranch).toBe(result.data.branchName);
			expect(result.messages).toContain("[quick-fix] Allocating fix branch name");
		} finally {
			fx.cleanup();
		}
	});

	test("initQuickFixBranch returns aborted when isLive flips to false after first git call", async () => {
		const fx = makeRealRepo();
		try {
			const manager = new WorktreeBranchManager(fakeEngine());
			const wf = makeWorkflow({
				workflowKind: "quick-fix",
				specification: "fix x",
				worktreePath: fx.worktree,
				targetRepository: fx.repo,
			});
			let calls = 0;
			const isLive = () => {
				calls++;
				return calls < 2; // live for first await, dead by second check
			};
			const result = await manager.initQuickFixBranch(wf, isLive);
			expect("aborted" in result && result.aborted).toBe(true);
			// Mutation must NOT have happened — the abort fires before featureBranch is set
			expect(wf.featureBranch).toBeNull();
		} finally {
			fx.cleanup();
		}
	});

	test("detectFeatureBranch returns null when specs/ does not exist", () => {
		const manager = new WorktreeBranchManager(fakeEngine());
		const wf = makeWorkflow({ worktreePath: "/nonexistent/path" });
		const result = manager.detectFeatureBranch(wf);
		expect(result.detected).toBeNull();
	});

	test("detectFeatureBranch picks the latest timestamped dir over any sequence dir", () => {
		const root = mkdtempSync(join(tmpdir(), "wbm-detect-"));
		const specs = join(root, "specs");
		mkdirSync(specs);
		try {
			for (const name of [
				"001-old-feature",
				"20260101-120000-early",
				"20260501-090000-latest",
				"002-also-old",
			]) {
				mkdirSync(join(specs, name));
			}
			const manager = new WorktreeBranchManager(fakeEngine());
			const wf = makeWorkflow({ worktreePath: root });
			expect(manager.detectFeatureBranch(wf).detected).toBe("20260501-090000-latest");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("detectFeatureBranch picks highest sequence prefix when no timestamp dirs exist", () => {
		const root = mkdtempSync(join(tmpdir(), "wbm-detect-seq-"));
		const specs = join(root, "specs");
		mkdirSync(specs);
		try {
			for (const name of ["001-foo", "017-bar", "003-baz"]) mkdirSync(join(specs, name));
			const manager = new WorktreeBranchManager(fakeEngine());
			const wf = makeWorkflow({ worktreePath: root });
			expect(manager.detectFeatureBranch(wf).detected).toBe("017-bar");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("checkoutMasterInWorktree calls injected checkoutMaster fn against the worktree path and emits ok message", async () => {
		const calls: string[] = [];
		const manager = new WorktreeBranchManager(fakeEngine(), {
			checkoutMaster: async (cwd: string) => {
				calls.push(cwd);
				return { code: 0, stderr: "" };
			},
		});
		const wf = makeWorkflow({ worktreePath: "/tmp/some-worktree" });

		const result = await manager.checkoutMasterInWorktree(wf);
		expect("ok" in result && result.ok).toBe(true);
		expect(calls).toEqual(["/tmp/some-worktree"]);
		expect(result.messages).toEqual([
			"[git] fetch + checkout --detach origin/master | cwd=worktree",
			"✓ Checked out latest master in worktree",
		]);
	});

	test("checkoutMasterInWorktree surfaces stderr-derived error on non-zero exit", async () => {
		const manager = new WorktreeBranchManager(fakeEngine(), {
			checkoutMaster: async () => ({ code: 1, stderr: "boom" }),
		});
		const wf = makeWorkflow({ worktreePath: "/tmp/wt" });
		const result = await manager.checkoutMasterInWorktree(wf);
		if (!("ok" in result) || result.ok) throw new Error("expected error result");
		expect(result.error).toContain("boom");
	});

	test("initSpeckitInWorktree short-circuits with skipped-quickfix for quick-fix workflows", async () => {
		const manager = new WorktreeBranchManager(fakeEngine());
		const wf = makeWorkflow({ workflowKind: "quick-fix", worktreePath: "/tmp/wt" });
		const result = await manager.initSpeckitInWorktree(wf);
		if (!("ok" in result) || !result.ok) throw new Error("expected ok");
		expect(result.data.kind).toBe("skipped-quickfix");
		expect(result.messages).toEqual([]);
	});

	test("initSpeckitInWorktree surfaces error when ensureSpeckitSkills reports installed=false", async () => {
		const manager = new WorktreeBranchManager(fakeEngine(), {
			ensureSpeckitSkills: async () => ({
				installed: false,
				initResult: { code: 2, stderr: "uvx missing", stdout: "" },
			}),
		});
		const wf = makeWorkflow({ workflowKind: "spec", worktreePath: "/tmp/wt" });
		const result = await manager.initSpeckitInWorktree(wf);
		if (!("ok" in result) || result.ok) throw new Error("expected error");
		expect(result.error).toContain("uvx missing");
	});

	test("ensureBranchBeforeCommitPushPr is a no-op when current branch is not detached HEAD", async () => {
		const fx = makeRealRepo();
		try {
			execSync(`git -C "${fx.worktree}" checkout -b feature-x`, { stdio: "ignore" });
			const manager = new WorktreeBranchManager(fakeEngine());
			const wf = makeWorkflow({ worktreePath: fx.worktree, featureBranch: "feature-x" });
			const result = await manager.ensureBranchBeforeCommitPushPr(wf, fx.worktree);
			if (!("ok" in result) || !result.ok) throw new Error("expected ok");
			expect(result.messages).toEqual([]);
		} finally {
			fx.cleanup();
		}
	});

	test("restoreClaudeMdBeforePush forwards guard outcomes into structured result", async () => {
		const manager = new WorktreeBranchManager(fakeEngine(), {
			guardClaudeMd: async () => ({ outcome: "unchanged" }),
		});
		const wf = makeWorkflow({ worktreePath: "/tmp/wt" });
		const r = await manager.restoreClaudeMdBeforePush(wf);
		expect(r.outcome).toBe("unchanged");
		expect(r.commitSha).toBeNull();
		expect(r.messages[0]).toContain("unchanged vs merge-base");
	});

	test("renameWorktreeToFeatureBranch returns renamed=false when engine.moveWorktree throws", async () => {
		const engine = new WorkflowEngine();
		// biome-ignore lint/suspicious/noExplicitAny: stub for failure-path test
		(engine as any).moveWorktree = async () => {
			throw new Error("rename-failed");
		};
		const manager = new WorktreeBranchManager(engine);
		const wf = makeWorkflow({
			worktreePath: "/tmp/wt-tmp",
			targetRepository: "/tmp/repo",
			featureBranch: "001-new",
		});
		const result = await manager.renameWorktreeToFeatureBranch(wf);
		expect(result.renamed).toBe(false);
		expect(wf.worktreePath).toBe("/tmp/wt-tmp");
	});

	test("createWorktreeAndCheckout cleans up and resets worktreePath when copyGitignoredFiles fails", async () => {
		const engine = new WorkflowEngine();
		const removed: string[] = [];
		// biome-ignore lint/suspicious/noExplicitAny: minimal stubs for failure-path test
		const e = engine as any;
		e.createWorktree = async () => "/tmp/created-wt";
		e.copyGitignoredFiles = async () => {
			throw new Error("disk-full");
		};
		e.removeWorktree = async (p: string) => {
			removed.push(p);
		};
		const manager = new WorktreeBranchManager(engine);
		const wf = makeWorkflow({ targetRepository: "/tmp/repo", worktreeBranch: "tmp-abc" });
		const result = await manager.createWorktreeAndCheckout(wf);
		if (!("ok" in result) || result.ok) throw new Error("expected error");
		expect(result.error).toContain("disk-full");
		expect(removed).toEqual(["/tmp/created-wt"]);
		expect(wf.worktreePath).toBeNull();
	});

	test("shouldRenameWorktree returns true only when worktreePath dirname starts with 'tmp-' and feature branch + target repo are set", () => {
		const manager = new WorktreeBranchManager(fakeEngine());

		expect(
			manager.shouldRenameWorktree(
				makeWorkflow({
					featureBranch: "001-foo",
					worktreePath: "/tmp/.worktrees/tmp-abc",
					targetRepository: "/tmp/repo",
				}),
			),
		).toBe(true);

		expect(
			manager.shouldRenameWorktree(
				makeWorkflow({
					featureBranch: "001-foo",
					worktreePath: "/tmp/.worktrees/001-foo",
					targetRepository: "/tmp/repo",
				}),
			),
		).toBe(false);

		expect(
			manager.shouldRenameWorktree(
				makeWorkflow({
					featureBranch: null,
					worktreePath: "/tmp/.worktrees/tmp-abc",
					targetRepository: "/tmp/repo",
				}),
			),
		).toBe(false);
	});
});
