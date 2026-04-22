import { test as baseTest, describe, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardClaudeMd } from "../../src/claude-md-guard";

// Each test spawns multiple real git processes (init/clone/fetch/commit). On
// Windows under parallel `bun test` load, the default 5s timeout is flaky.
const TEST_TIMEOUT_MS = 60_000;
const test = (name: string, fn: () => Promise<void>) => baseTest(name, fn, TEST_TIMEOUT_MS);

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
	if (r.code !== 0) {
		throw new Error(`command failed (${cmd.join(" ")}) in ${cwd}: ${r.stderr || r.stdout}`);
	}
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
	origin: string; // bare-ish origin (master branch)
	work: string; // feature branch worktree
	cleanup: () => Promise<void>;
}

/**
 * Create a fixture with:
 *   - an "origin" repo on branch master with `baseContent` at CLAUDE.md (null = no file)
 *   - a "work" clone that tracks `origin/master`, on a feature branch
 *   - if `headContent` is provided, it is committed on the feature branch
 *     (null-with-base → deletion commit; string → write+commit)
 */
async function makeFixture(opts: {
	baseContent: string | null;
	branchAction: "none" | "modify" | "delete" | "add";
	branchContent?: string; // for modify / add
	extraHeadFile?: { name: string; content: string };
	disjoint?: boolean;
}): Promise<Fixture> {
	const origin = mkdtempSync(join(tmpdir(), "guard-origin-"));
	const work = mkdtempSync(join(tmpdir(), "guard-work-"));
	const cleanup = async () => {
		await rmWithRetry(origin);
		await rmWithRetry(work);
	};

	try {
		// origin on master
		await mustRun(["git", "init", "-b", "master"], origin);
		writeFileSync(join(origin, "seed.txt"), "seed");
		await mustRun(["git", "add", "."], origin);
		if (opts.baseContent !== null) {
			writeFileSync(join(origin, "CLAUDE.md"), opts.baseContent);
			// global excludesFile commonly ignores CLAUDE.md — force-add it in fixtures.
			await mustRun(["git", "add", "-f", "CLAUDE.md"], origin);
		}
		await mustRun(["git", "commit", "-m", "init"], origin);

		if (opts.disjoint) {
			// work is a completely separate repo; origin is added as remote
			// but has no shared ancestor with work's master.
			await mustRun(["git", "init", "-b", "master"], work);
			// guardClaudeMd's internal `git commit` uses gitSpawn which does NOT
			// forward GIT_AUTHOR_* env vars; configure local identity so CI
			// (no global user.name/email) can commit.
			await mustRun(["git", "config", "user.email", "t@e.com"], work);
			await mustRun(["git", "config", "user.name", "Test"], work);
			writeFileSync(join(work, "other.txt"), "other");
			await mustRun(["git", "add", "."], work);
			await mustRun(["git", "commit", "-m", "independent"], work);
			await mustRun(["git", "remote", "add", "origin", origin], work);
			await mustRun(["git", "fetch", "origin"], work);
			// create and switch to a feature branch (still disjoint from origin/master)
			await mustRun(["git", "switch", "-c", "feat"], work);
		} else {
			// clone so HEAD starts at origin/master base content
			await mustRun(["git", "clone", origin, work], process.cwd());
			// guardClaudeMd's internal `git commit` uses gitSpawn which does NOT
			// forward GIT_AUTHOR_* env vars; configure local identity so CI
			// (no global user.name/email) can commit.
			await mustRun(["git", "config", "user.email", "t@e.com"], work);
			await mustRun(["git", "config", "user.name", "Test"], work);
			await mustRun(["git", "switch", "-c", "feat"], work);

			if (opts.branchAction === "delete") {
				await mustRun(["git", "rm", "--quiet", "CLAUDE.md"], work);
				await mustRun(["git", "commit", "-m", "delete claude md"], work);
			} else if (opts.branchAction === "modify" || opts.branchAction === "add") {
				const content = opts.branchContent ?? "y";
				writeFileSync(join(work, "CLAUDE.md"), content);
				if (opts.extraHeadFile) {
					writeFileSync(join(work, opts.extraHeadFile.name), opts.extraHeadFile.content);
				}
				await mustRun(["git", "add", "-f", "CLAUDE.md"], work);
				if (opts.extraHeadFile) await mustRun(["git", "add", opts.extraHeadFile.name], work);
				await mustRun(["git", "commit", "-m", "update"], work);
			}
		}

		return { origin, work, cleanup };
	} catch (err) {
		await cleanup();
		throw err;
	}
}

async function countCommits(cwd: string): Promise<number> {
	const r = await mustRun(["git", "rev-list", "--count", "HEAD"], cwd);
	return parseInt(r.stdout.trim(), 10);
}

describe("guardClaudeMd", () => {
	test("base has file; HEAD identical → unchanged", async () => {
		const fx = await makeFixture({ baseContent: "x", branchAction: "none" });
		try {
			const before = await countCommits(fx.work);
			const result = await guardClaudeMd(fx.work);
			expect(result).toEqual({ outcome: "unchanged" });
			expect(await countCommits(fx.work)).toBe(before);
			expect(await readFile(join(fx.work, "CLAUDE.md"), "utf-8")).toBe("x");
		} finally {
			await fx.cleanup();
		}
	});

	test("base has file; HEAD modified → restored content-replaced", async () => {
		const fx = await makeFixture({ baseContent: "x", branchAction: "modify", branchContent: "y" });
		try {
			const before = await countCommits(fx.work);
			const result = await guardClaudeMd(fx.work);
			expect(result.outcome).toBe("restored");
			if (result.outcome === "restored") {
				expect(result.action).toBe("content-replaced");
				expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
			}
			expect(await countCommits(fx.work)).toBe(before + 1);
			expect(await readFile(join(fx.work, "CLAUDE.md"), "utf-8")).toBe("x");
		} finally {
			await fx.cleanup();
		}
	});

	test("base has no file; HEAD added one → restored removed", async () => {
		const fx = await makeFixture({ baseContent: null, branchAction: "add", branchContent: "y" });
		try {
			const before = await countCommits(fx.work);
			const result = await guardClaudeMd(fx.work);
			expect(result.outcome).toBe("restored");
			if (result.outcome === "restored") {
				expect(result.action).toBe("removed");
			}
			expect(await countCommits(fx.work)).toBe(before + 1);
			expect(existsSync(join(fx.work, "CLAUDE.md"))).toBe(false);
		} finally {
			await fx.cleanup();
		}
	});

	test("base has file; HEAD deleted it → restored recreated", async () => {
		const fx = await makeFixture({ baseContent: "x", branchAction: "delete" });
		try {
			const before = await countCommits(fx.work);
			const result = await guardClaudeMd(fx.work);
			expect(result.outcome).toBe("restored");
			if (result.outcome === "restored") {
				expect(result.action).toBe("recreated");
			}
			expect(await countCommits(fx.work)).toBe(before + 1);
			expect(await readFile(join(fx.work, "CLAUDE.md"), "utf-8")).toBe("x");
		} finally {
			await fx.cleanup();
		}
	});

	test("neither has a file → unchanged", async () => {
		const fx = await makeFixture({ baseContent: null, branchAction: "none" });
		try {
			const before = await countCommits(fx.work);
			const result = await guardClaudeMd(fx.work);
			expect(result).toEqual({ outcome: "unchanged" });
			expect(await countCommits(fx.work)).toBe(before);
			expect(existsSync(join(fx.work, "CLAUDE.md"))).toBe(false);
		} finally {
			await fx.cleanup();
		}
	});

	test("unrelated files also changed → only CLAUDE.md reverted", async () => {
		const fx = await makeFixture({
			baseContent: "x",
			branchAction: "modify",
			branchContent: "y",
			extraHeadFile: { name: "foo.md", content: "hello" },
		});
		try {
			const before = await countCommits(fx.work);
			const result = await guardClaudeMd(fx.work);
			expect(result.outcome).toBe("restored");
			expect(await countCommits(fx.work)).toBe(before + 1);
			expect(await readFile(join(fx.work, "CLAUDE.md"), "utf-8")).toBe("x");
			// foo.md remains present and tracked at the branch tip
			expect(await readFile(join(fx.work, "foo.md"), "utf-8")).toBe("hello");
			const show = await run(["git", "show", "HEAD:foo.md"], fx.work);
			expect(show.code).toBe(0);
			expect(show.stdout.trim()).toBe("hello");
		} finally {
			await fx.cleanup();
		}
	});

	test("unrelated files staged but uncommitted → restore commit only touches CLAUDE.md", async () => {
		const fx = await makeFixture({ baseContent: "x", branchAction: "modify", branchContent: "y" });
		try {
			// Pre-stage an unrelated file WITHOUT committing. A bare `git commit`
			// would sweep this file into the restore commit and silently violate
			// FR-005 ("restoration step MUST leave all other files untouched").
			writeFileSync(join(fx.work, "leaked.md"), "leak");
			await mustRun(["git", "add", "leaked.md"], fx.work);

			const before = await countCommits(fx.work);
			const result = await guardClaudeMd(fx.work);
			expect(result.outcome).toBe("restored");
			expect(await countCommits(fx.work)).toBe(before + 1);

			// Restore commit contains exactly one path: CLAUDE.md
			const files = await mustRun(
				["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
				fx.work,
			);
			expect(files.stdout.trim().split(/\r?\n/)).toEqual(["CLAUDE.md"]);

			// `leaked.md` is still staged (index), not committed.
			const statusRes = await mustRun(["git", "status", "--porcelain", "leaked.md"], fx.work);
			expect(statusRes.stdout).toMatch(/^A\s+leaked\.md/);
		} finally {
			await fx.cleanup();
		}
	});

	test("disjoint histories → no-merge-base", async () => {
		const fx = await makeFixture({
			baseContent: "x",
			branchAction: "modify",
			branchContent: "y",
			disjoint: true,
		});
		try {
			const before = await countCommits(fx.work);
			const result = await guardClaudeMd(fx.work);
			expect(result).toEqual({ outcome: "no-merge-base" });
			expect(await countCommits(fx.work)).toBe(before);
		} finally {
			await fx.cleanup();
		}
	});

	test("origin/master ref missing → throws (not misclassified as no-merge-base)", async () => {
		const fx = await makeFixture({ baseContent: "x", branchAction: "modify", branchContent: "y" });
		try {
			// Remove the origin remote entirely so `git fetch origin master` AND
			// `git merge-base HEAD origin/master` both fail. The merge-base call
			// will exit 128 ("Not a valid object name") with non-empty stderr.
			// This MUST throw, not silently return no-merge-base (which would let
			// the push proceed against the guard's intent — see FR-007).
			await mustRun(["git", "remote", "remove", "origin"], fx.work);
			// Also purge the cached remote ref, otherwise merge-base may still
			// resolve `origin/master` via .git/refs/remotes/origin/master.
			await mustRun(["git", "update-ref", "-d", "refs/remotes/origin/master"], fx.work).catch(
				() => {},
			);
			await expect(guardClaudeMd(fx.work)).rejects.toThrow(/merge-base failed/);
		} finally {
			await fx.cleanup();
		}
	});

	test("git commit fails (pre-commit hook) → throws", async () => {
		const fx = await makeFixture({ baseContent: "x", branchAction: "modify", branchContent: "y" });
		try {
			// Install a failing pre-commit hook.
			const hooksDir = join(fx.work, ".git", "hooks");
			const hookPath = join(hooksDir, "pre-commit");
			writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
			try {
				chmodSync(hookPath, 0o755);
			} catch {
				// chmod may not apply on Windows; git on Windows ignores the executable bit
				// but still honors .git/hooks/pre-commit via sh.exe. If no sh is available
				// the hook won't fire — skip the assertion in that case.
			}
			const before = await countCommits(fx.work);
			await expect(guardClaudeMd(fx.work)).rejects.toThrow(/claude-md-guard: commit failed/);
			// No new commit landed.
			expect(await countCommits(fx.work)).toBe(before);
		} finally {
			await fx.cleanup();
		}
	});
});
