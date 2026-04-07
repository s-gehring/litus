import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateTargetRepository } from "../src/target-repo-validator";

// Create temp directories for testing
const testRoot = join(tmpdir(), `litus-test-${Date.now()}`);
const gitRepoPath = join(testRoot, "valid-repo");
const nonGitDir = join(testRoot, "not-a-repo");
const filePath = join(testRoot, "a-file.txt");

beforeAll(async () => {
	mkdirSync(gitRepoPath, { recursive: true });
	mkdirSync(nonGitDir, { recursive: true });
	writeFileSync(filePath, "hello");

	// Init a git repo in gitRepoPath
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

describe("validateTargetRepository", () => {
	test("rejects empty string", async () => {
		const result = await validateTargetRepository("");
		expect(result.valid).toBe(false);
		expect(result.error).toContain("required");
	});

	test("rejects undefined", async () => {
		const result = await validateTargetRepository(undefined);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("required");
	});

	test("rejects whitespace-only", async () => {
		const result = await validateTargetRepository("   ");
		expect(result.valid).toBe(false);
		expect(result.error).toContain("required");
	});

	test("rejects relative path", async () => {
		const result = await validateTargetRepository("relative/path");
		expect(result.valid).toBe(false);
		expect(result.error).toContain("absolute path");
	});

	test("rejects non-existent path", async () => {
		const result = await validateTargetRepository(join(testRoot, "does-not-exist"));
		expect(result.valid).toBe(false);
		expect(result.error).toContain("does not exist");
	});

	test("rejects non-git directory", async () => {
		const result = await validateTargetRepository(nonGitDir);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("not a git repository");
	});

	test("accepts valid git repository", async () => {
		const result = await validateTargetRepository(gitRepoPath);
		expect(result.valid).toBe(true);
		expect(result.effectivePath).toBe(gitRepoPath);
		expect(result.error).toBeUndefined();
	});

	test("accepts path with spaces and special characters", async () => {
		const spacePath = join(testRoot, "path with spaces & (parens)");
		mkdirSync(spacePath, { recursive: true });
		const proc = Bun.spawn(["git", "init"], {
			cwd: spacePath,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		const result = await validateTargetRepository(spacePath);
		expect(result.valid).toBe(true);
		expect(result.effectivePath).toBe(spacePath);
	});

	test("accepts bare git repository", async () => {
		const bareRepoPath = join(testRoot, "bare-repo.git");
		mkdirSync(bareRepoPath, { recursive: true });
		const proc = Bun.spawn(["git", "init", "--bare"], {
			cwd: bareRepoPath,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		const result = await validateTargetRepository(bareRepoPath);
		expect(result.valid).toBe(true);
		expect(result.effectivePath).toBe(bareRepoPath);
	});
});
