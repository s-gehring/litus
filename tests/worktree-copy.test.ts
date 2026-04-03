import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow-engine";

const originalSpawn = Bun.spawn;
const BunGlobal = globalThis as unknown as { Bun: { spawn: unknown } };

describe("worktree gitignored file copy", () => {
	let engine: WorkflowEngine;
	let sourceDir: string;

	beforeEach(async () => {
		engine = new WorkflowEngine();
		sourceDir = await mkdtemp(join(tmpdir(), "crab-src-"));

		// Mock git worktree creation — capture the resolved worktree path
		BunGlobal.Bun.spawn = (_cmd: unknown, opts: { cwd?: string }) => {
			// The worktree path is relative to cwd, compute it the same way the engine does
			const cwd = opts?.cwd || process.cwd();
			// We don't know the exact branch name yet, but we can create the dir on exited
			return {
				exited: (async () => {
					// Find the .worktrees dir that will be created
					const worktreesBase = join(cwd, ".worktrees");
					await mkdir(worktreesBase, { recursive: true });
					// We need to figure out the actual path — list after mkdir
					// The engine uses `.worktrees/${branchName.replaceAll("/", "-")}`
					// We'll just create a known dir and let the engine resolve it
					return 0;
				})(),
				stdout: null,
				stderr: null,
				kill: () => {},
				pid: 1234,
			};
		};
	});

	afterEach(async () => {
		BunGlobal.Bun.spawn = originalSpawn;
		await rm(sourceDir, { recursive: true, force: true });
	});

	test("copies existing gitignored directories into worktree", async () => {
		// Create source files
		await mkdir(join(sourceDir, ".serena"), { recursive: true });
		await writeFile(join(sourceDir, ".serena", "config.json"), '{"key":"value"}');
		await mkdir(join(sourceDir, ".claude"), { recursive: true });
		await writeFile(join(sourceDir, ".claude", "settings.json"), '{"s":1}');
		await mkdir(join(sourceDir, "specs"), { recursive: true });
		await writeFile(join(sourceDir, "specs", "feature.md"), "# Feature");
		await writeFile(join(sourceDir, "CLAUDE.md"), "# Instructions");

		const w = await engine.createWorkflow("test", sourceDir);
		const wt = w.worktreePath as string;

		expect(await readFile(join(wt, ".serena", "config.json"), "utf-8")).toBe('{"key":"value"}');
		expect(await readFile(join(wt, ".claude", "settings.json"), "utf-8")).toBe('{"s":1}');
		expect(await readFile(join(wt, "specs", "feature.md"), "utf-8")).toBe("# Feature");
		expect(await readFile(join(wt, "CLAUDE.md"), "utf-8")).toBe("# Instructions");
	});

	test("skips missing gitignored paths without error", async () => {
		// Source has none of the gitignored files — should not throw
		const w = await engine.createWorkflow("test", sourceDir);
		expect(w.worktreePath).toBeTruthy();
	});

	test("copies .specify directory when present", async () => {
		await mkdir(join(sourceDir, ".specify"), { recursive: true });
		await writeFile(join(sourceDir, ".specify", "data.yml"), "key: val");

		const w = await engine.createWorkflow("test", sourceDir);
		const wt = w.worktreePath as string;

		expect(await readFile(join(wt, ".specify", "data.yml"), "utf-8")).toBe("key: val");
	});

	test("copies only paths that exist, ignores missing ones", async () => {
		// Only CLAUDE.md exists
		await writeFile(join(sourceDir, "CLAUDE.md"), "# Only this");

		const w = await engine.createWorkflow("test", sourceDir);
		const wt = w.worktreePath as string;

		expect(await readFile(join(wt, "CLAUDE.md"), "utf-8")).toBe("# Only this");
		// .serena should not exist in worktree
		const entries = await readdir(wt);
		expect(entries).not.toContain(".serena");
	});
});
