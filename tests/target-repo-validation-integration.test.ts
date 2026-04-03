import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateTargetRepository } from "../src/target-repo-validator";

/**
 * Integration tests for target repository validation as used in the handleStart flow.
 * Tests the contract from contracts/websocket.md: error messages must match exactly.
 */

const testRoot = join(tmpdir(), `crab-studio-integ-${Date.now()}`);
const gitRepoPath = join(testRoot, "valid-repo");
const nonGitDir = join(testRoot, "not-a-repo");

beforeAll(async () => {
	mkdirSync(gitRepoPath, { recursive: true });
	mkdirSync(nonGitDir, { recursive: true });

	const proc = Bun.spawn(["git", "init"], {
		cwd: gitRepoPath,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
});

afterAll(() => {
	rmSync(testRoot, { recursive: true, force: true });
});

describe("target repository validation integration (handleStart flow)", () => {
	test("relative path returns error matching contract", async () => {
		const result = await validateTargetRepository("relative/path");
		expect(result.valid).toBe(false);
		expect(result.error).toBe("Target repository must be an absolute path");
	});

	test("non-existent path returns error matching contract", async () => {
		const fakePath = join(testRoot, "nope");
		const result = await validateTargetRepository(fakePath);
		expect(result.valid).toBe(false);
		expect(result.error).toBe(`Target repository path does not exist: ${fakePath}`);
	});

	test("non-git-repo returns error matching contract", async () => {
		const result = await validateTargetRepository(nonGitDir);
		expect(result.valid).toBe(false);
		expect(result.error).toBe(`Target repository is not a git repository: ${nonGitDir}`);
	});

	test("empty string falls back to CWD (no error)", async () => {
		const result = await validateTargetRepository("");
		expect(result.valid).toBe(true);
		expect(result.effectivePath).toBe(process.cwd());
		expect(result.error).toBeUndefined();
	});

	test("valid repo path passes validation", async () => {
		const result = await validateTargetRepository(gitRepoPath);
		expect(result.valid).toBe(true);
		expect(result.effectivePath).toBe(gitRepoPath);
	});
});
