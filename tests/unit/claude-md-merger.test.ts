import { test as baseTest, describe, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendProjectClaudeMd,
	markClaudeMdSkipWorktree,
	PROJECT_CLAUDEMD_SEPARATOR,
	resolveMainWorktreeRoot,
} from "../../src/claude-md-merger";

// Each test spawns real git processes; under parallel load on Windows the 5s
// default is flaky. Use a generous per-test timeout.
const TEST_TIMEOUT_MS = 60_000;
const test = (name: string, fn: () => Promise<void>) => baseTest(name, fn, TEST_TIMEOUT_MS);

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "t@e.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "t@e.com",
};

async function run(cmd: string[], cwd: string): Promise<number> {
	const p = Bun.spawn(cmd, { cwd, env: GIT_ENV, stdout: "ignore", stderr: "ignore" });
	return await p.exited;
}

async function runCapture(cmd: string[], cwd: string): Promise<{ code: number; stdout: string }> {
	const p = Bun.spawn(cmd, { cwd, env: GIT_ENV, stdout: "pipe", stderr: "ignore" });
	const code = await p.exited;
	const stdout = await new Response(p.stdout).text();
	return { code, stdout };
}

interface Fixture {
	main: string;
	spec: string;
	cleanup: () => void;
}

async function makeFixture(opts?: {
	projectContent?: string | null;
	gitignoreClaudeMd?: boolean;
	/** When true, CLAUDE.md is committed in main BEFORE the worktree is
	 *  created — so the worktree's index has CLAUDE.md tracked. Defaults to
	 *  false to preserve existing test semantics. */
	commitClaudeMdInMain?: boolean;
}): Promise<Fixture> {
	const main = mkdtempSync(join(tmpdir(), "crab-merger-main-"));
	const worktreesRoot = mkdtempSync(join(tmpdir(), "crab-merger-wt-"));
	const spec = join(worktreesRoot, "spec");

	const cleanup = () => {
		rmSync(main, { recursive: true, force: true });
		rmSync(worktreesRoot, { recursive: true, force: true });
	};

	try {
		if ((await run(["git", "init", "-b", "main"], main)) !== 0) throw new Error("git init failed");
		writeFileSync(join(main, "seed.txt"), "seed");
		if (opts?.gitignoreClaudeMd) writeFileSync(join(main, ".gitignore"), "CLAUDE.md\n");
		if ((await run(["git", "add", "."], main)) !== 0) throw new Error("git add failed");
		if ((await run(["git", "commit", "-m", "init"], main)) !== 0)
			throw new Error("git commit failed");

		if (opts?.projectContent !== null && opts?.projectContent !== undefined) {
			writeFileSync(join(main, "CLAUDE.md"), opts.projectContent);
		}

		if (opts?.commitClaudeMdInMain) {
			if ((await run(["git", "add", "CLAUDE.md"], main)) !== 0)
				throw new Error("git add CLAUDE.md failed");
			if ((await run(["git", "commit", "-m", "add CLAUDE.md"], main)) !== 0)
				throw new Error("git commit CLAUDE.md failed");
		}

		if ((await run(["git", "worktree", "add", "--detach", spec], main)) !== 0) {
			throw new Error("git worktree add failed");
		}

		return { main, spec, cleanup };
	} catch (err) {
		cleanup();
		throw err;
	}
}

describe("resolveMainWorktreeRoot", () => {
	test("returns null for non-git directory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "crab-merger-nogit-"));
		try {
			expect(await resolveMainWorktreeRoot(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns the main worktree path from a secondary worktree", async () => {
		const fx = await makeFixture({ projectContent: "X" });
		try {
			const resolved = await resolveMainWorktreeRoot(fx.spec);
			expect(resolved).not.toBeNull();
			// Normalize path separators — git emits forward slashes, fs uses backslashes on Windows.
			const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
			expect(norm(resolved ?? "")).toBe(norm(fx.main));
		} finally {
			fx.cleanup();
		}
	});

	test("returns the main worktree when multiple secondary worktrees exist", async () => {
		const fx = await makeFixture({ projectContent: "X" });
		const extraRoot = mkdtempSync(join(tmpdir(), "crab-merger-wt2-"));
		const extra = join(extraRoot, "extra");
		try {
			// Add a second secondary worktree to force porcelain output with multiple entries.
			if ((await run(["git", "worktree", "add", "--detach", extra], fx.main)) !== 0) {
				throw new Error("git worktree add failed");
			}
			// Resolve from the *second* secondary — the main must still be returned
			// regardless of ordering in porcelain output.
			const resolved = await resolveMainWorktreeRoot(extra);
			expect(resolved).not.toBeNull();
			const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
			expect(norm(resolved ?? "")).toBe(norm(fx.main));
		} finally {
			rmSync(extraRoot, { recursive: true, force: true });
			fx.cleanup();
		}
	});
});

describe("appendProjectClaudeMd — contract test matrix", () => {
	test("case 1: main 'X\\n' + generated 'Y' → appended, file = Y + sep + X\\n", async () => {
		const fx = await makeFixture({ projectContent: "X\n" });
		try {
			writeFileSync(join(fx.spec, "CLAUDE.md"), "Y");
			const r = await appendProjectClaudeMd(fx.spec);
			expect(r.outcome).toBe("appended");
			const after = await readFile(join(fx.spec, "CLAUDE.md"), "utf-8");
			expect(after).toBe(`Y${PROJECT_CLAUDEMD_SEPARATOR}X\n`);
		} finally {
			fx.cleanup();
		}
	});

	test("case 4: idempotent skip when generated already ends with suffix", async () => {
		const fx = await makeFixture({ projectContent: "X" });
		try {
			const start = `Y${PROJECT_CLAUDEMD_SEPARATOR}X`;
			writeFileSync(join(fx.spec, "CLAUDE.md"), start);
			const r = await appendProjectClaudeMd(fx.spec);
			expect(r.outcome).toBe("skipped");
			const after = await readFile(join(fx.spec, "CLAUDE.md"), "utf-8");
			expect(after).toBe(start);
		} finally {
			fx.cleanup();
		}
	});

	test("case 5: project file without trailing newline still appended cleanly", async () => {
		const fx = await makeFixture({ projectContent: "X" });
		try {
			writeFileSync(join(fx.spec, "CLAUDE.md"), "Y");
			const r = await appendProjectClaudeMd(fx.spec);
			expect(r.outcome).toBe("appended");
			const after = await readFile(join(fx.spec, "CLAUDE.md"), "utf-8");
			expect(after).toBe(`Y${PROJECT_CLAUDEMD_SEPARATOR}X`);
		} finally {
			fx.cleanup();
		}
	});

	test("case 7: generated CLAUDE.md missing → throws", async () => {
		const fx = await makeFixture({ projectContent: "X" });
		try {
			await expect(appendProjectClaudeMd(fx.spec)).rejects.toThrow();
		} finally {
			fx.cleanup();
		}
	});

	test("case 8: stale suffix replaced with fresh content", async () => {
		const fx = await makeFixture({ projectContent: "X" });
		try {
			const start = `Y${PROJECT_CLAUDEMD_SEPARATOR}Z`;
			writeFileSync(join(fx.spec, "CLAUDE.md"), start);
			const r = await appendProjectClaudeMd(fx.spec);
			expect(r.outcome).toBe("appended");
			const after = await readFile(join(fx.spec, "CLAUDE.md"), "utf-8");
			expect(after).toBe(`${start}${PROJECT_CLAUDEMD_SEPARATOR}X`);
		} finally {
			fx.cleanup();
		}
	});

	test("case 2: main has no CLAUDE.md → no-project, generated unchanged", async () => {
		const fx = await makeFixture({ projectContent: null });
		try {
			writeFileSync(join(fx.spec, "CLAUDE.md"), "Y");
			const r = await appendProjectClaudeMd(fx.spec);
			expect(r.outcome).toBe("no-project");
			const after = await readFile(join(fx.spec, "CLAUDE.md"), "utf-8");
			expect(after).toBe("Y");
		} finally {
			fx.cleanup();
		}
	});

	test("case 3: main has empty CLAUDE.md → no-project, generated unchanged", async () => {
		const fx = await makeFixture({ projectContent: "" });
		try {
			writeFileSync(join(fx.spec, "CLAUDE.md"), "Y");
			const r = await appendProjectClaudeMd(fx.spec);
			expect(r.outcome).toBe("no-project");
			const after = await readFile(join(fx.spec, "CLAUDE.md"), "utf-8");
			expect(after).toBe("Y");
		} finally {
			fx.cleanup();
		}
	});

	test("case 6: main-worktree resolution fails (non-git dir) → no-main", async () => {
		const dir = mkdtempSync(join(tmpdir(), "crab-merger-nogit2-"));
		try {
			writeFileSync(join(dir, "CLAUDE.md"), "Y");
			const r = await appendProjectClaudeMd(dir);
			expect(r.outcome).toBe("no-main");
			const after = await readFile(join(dir, "CLAUDE.md"), "utf-8");
			expect(after).toBe("Y");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("main CLAUDE.md is a directory (unreadable) → no-project, generated unchanged", async () => {
		// Exercises the readIfExists warn-and-skip branch for non-ENOENT errors:
		// reading a directory as a file surfaces EISDIR, which must map to no-project.
		const fx = await makeFixture({ projectContent: null });
		try {
			mkdirSync(join(fx.main, "CLAUDE.md"));
			writeFileSync(join(fx.spec, "CLAUDE.md"), "Y");
			const r = await appendProjectClaudeMd(fx.spec);
			expect(r.outcome).toBe("no-project");
			const after = await readFile(join(fx.spec, "CLAUDE.md"), "utf-8");
			expect(after).toBe("Y");
		} finally {
			fx.cleanup();
		}
	});

	test("gitignored project CLAUDE.md in main is still honored", async () => {
		const fx = await makeFixture({ projectContent: "IGNORED-X", gitignoreClaudeMd: true });
		try {
			writeFileSync(join(fx.spec, "CLAUDE.md"), "Y");
			const r = await appendProjectClaudeMd(fx.spec);
			expect(r.outcome).toBe("appended");
			const after = await readFile(join(fx.spec, "CLAUDE.md"), "utf-8");
			expect(after).toBe(`Y${PROJECT_CLAUDEMD_SEPARATOR}IGNORED-X`);
		} finally {
			fx.cleanup();
		}
	});
});

describe("markClaudeMdSkipWorktree", () => {
	test("returns 'marked' when CLAUDE.md is tracked in the worktree index", async () => {
		const fx = await makeFixture({ projectContent: "PROJECT\n", commitClaudeMdInMain: true });
		try {
			const r = await markClaudeMdSkipWorktree(fx.spec);
			expect(r.outcome).toBe("marked");

			const lsFiles = await runCapture(["git", "ls-files", "-v", "CLAUDE.md"], fx.spec);
			expect(lsFiles.code).toBe(0);
			// `git ls-files -v` prefixes skip-worktree entries with a lowercase
			// letter (e.g. 'S CLAUDE.md'); tracked-without-flag uses uppercase 'H'.
			expect(lsFiles.stdout.trim().startsWith("S ")).toBe(true);
		} finally {
			fx.cleanup();
		}
	});

	test("returns 'not-tracked' when CLAUDE.md is absent from the index", async () => {
		const fx = await makeFixture();
		try {
			const r = await markClaudeMdSkipWorktree(fx.spec);
			expect(r.outcome).toBe("not-tracked");
		} finally {
			fx.cleanup();
		}
	});

	test("after marking, modifying CLAUDE.md does not show up in `git status` or `git add -A`", async () => {
		const fx = await makeFixture({ projectContent: "PROJECT\n", commitClaudeMdInMain: true });
		try {
			const r = await markClaudeMdSkipWorktree(fx.spec);
			expect(r.outcome).toBe("marked");

			// Simulate appendProjectClaudeMd's effect: rewrite the worktree's
			// CLAUDE.md with assembled content.
			writeFileSync(join(fx.spec, "CLAUDE.md"), `PROJECT${PROJECT_CLAUDEMD_SEPARATOR}PROJECT\n`);

			const status = await runCapture(["git", "status", "--porcelain"], fx.spec);
			expect(status.code).toBe(0);
			expect(status.stdout).not.toContain("CLAUDE.md");

			expect(await run(["git", "add", "-A"], fx.spec)).toBe(0);
			const diffCached = await runCapture(["git", "diff", "--cached", "--name-only"], fx.spec);
			expect(diffCached.code).toBe(0);
			expect(diffCached.stdout).not.toContain("CLAUDE.md");
		} finally {
			fx.cleanup();
		}
	});

	test("idempotent — second invocation still reports 'marked'", async () => {
		const fx = await makeFixture({ projectContent: "PROJECT\n", commitClaudeMdInMain: true });
		try {
			const r1 = await markClaudeMdSkipWorktree(fx.spec);
			expect(r1.outcome).toBe("marked");
			const r2 = await markClaudeMdSkipWorktree(fx.spec);
			expect(r2.outcome).toBe("marked");
		} finally {
			fx.cleanup();
		}
	});
});
