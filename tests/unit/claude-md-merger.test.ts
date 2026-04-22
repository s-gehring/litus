import { test as baseTest, describe, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendProjectClaudeMd,
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

interface Fixture {
	main: string;
	spec: string;
	cleanup: () => void;
}

async function makeFixture(opts?: {
	projectContent?: string | null;
	gitignoreClaudeMd?: boolean;
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
