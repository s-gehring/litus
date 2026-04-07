import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkClaudeCli,
	checkGhAuth,
	checkGhInstalled,
	checkGitHubOrigin,
	checkGitInstalled,
	checkGitignoreEntries,
	checkIsGitRepo,
	checkSpeckitFiles,
	runSetupChecks,
	SPECKIT_FILES,
} from "../src/setup-checker";

const testRoot = join(tmpdir(), `crab-setup-test-${Date.now()}`);
const gitRepoPath = join(testRoot, "valid-repo");
const nonGitDir = join(testRoot, "not-a-repo");
const speckitCompleteDir = join(testRoot, "speckit-complete");
const speckitMissingDir = join(testRoot, "speckit-missing");

beforeAll(async () => {
	mkdirSync(gitRepoPath, { recursive: true });
	mkdirSync(nonGitDir, { recursive: true });
	mkdirSync(join(speckitCompleteDir, ".claude", "commands"), { recursive: true });
	mkdirSync(join(speckitMissingDir, ".claude", "commands"), { recursive: true });

	// Init git repo with a GitHub origin and speckit files
	const init = Bun.spawn(["git", "init"], { cwd: gitRepoPath, stdout: "pipe", stderr: "pipe" });
	await init.exited;
	// Disable global gitignore so tests control exactly what's ignored
	const disableGlobal = Bun.spawn(["git", "config", "core.excludesFile", ""], {
		cwd: gitRepoPath,
		stdout: "pipe",
		stderr: "pipe",
	});
	await disableGlobal.exited;
	const addRemote = Bun.spawn(
		["git", "remote", "add", "origin", "https://github.com/test-org/test-repo.git"],
		{ cwd: gitRepoPath, stdout: "pipe", stderr: "pipe" },
	);
	await addRemote.exited;
	mkdirSync(join(gitRepoPath, ".claude", "commands"), { recursive: true });
	for (const file of SPECKIT_FILES) {
		writeFileSync(join(gitRepoPath, ".claude", "commands", file), "# template");
	}

	// Create all speckit files in complete dir
	for (const file of SPECKIT_FILES) {
		writeFileSync(join(speckitCompleteDir, ".claude", "commands", file), "# template");
	}

	// Create only some speckit files in missing dir
	writeFileSync(join(speckitMissingDir, ".claude", "commands", "speckit.clarify.md"), "# template");
	writeFileSync(join(speckitMissingDir, ".claude", "commands", "speckit.plan.md"), "# template");
});

afterAll(() => {
	rmSync(testRoot, { recursive: true, force: true });
});

// T006: checkGitInstalled
describe("checkGitInstalled", () => {
	test("passes when git is installed", async () => {
		const result = await checkGitInstalled();
		expect(result.passed).toBe(true);
		expect(result.required).toBe(true);
		expect(result.error).toBeUndefined();
	});
});

// T007: checkIsGitRepo
describe("checkIsGitRepo", () => {
	test("passes for valid git repo", async () => {
		const result = await checkIsGitRepo(gitRepoPath);
		expect(result.passed).toBe(true);
		expect(result.required).toBe(true);
	});

	test("fails for non-repo directory", async () => {
		const result = await checkIsGitRepo(nonGitDir);
		expect(result.passed).toBe(false);
		expect(result.required).toBe(true);
		expect(result.error).toContain("not a git repository");
	});
});

// T008: checkGitHubOrigin
describe("checkGitHubOrigin", () => {
	test("passes for repo with GitHub origin", async () => {
		const result = await checkGitHubOrigin(gitRepoPath);
		expect(result.passed).toBe(true);
		expect(result.required).toBe(true);
	});

	test("fails for repo with no origin", async () => {
		// nonGitDir is not a git repo, but let's create a temp git repo without origin
		const noOriginDir = join(testRoot, "no-origin");
		mkdirSync(noOriginDir, { recursive: true });
		const proc = Bun.spawn(["git", "init"], { cwd: noOriginDir, stdout: "pipe", stderr: "pipe" });
		await proc.exited;

		const result = await checkGitHubOrigin(noOriginDir);
		expect(result.passed).toBe(false);
		expect(result.error).toContain("No GitHub remote");

		rmSync(noOriginDir, { recursive: true, force: true });
	});

	test("fails for non-GitHub origin", async () => {
		const nonGhDir = join(testRoot, "non-gh-origin");
		mkdirSync(nonGhDir, { recursive: true });
		const init = Bun.spawn(["git", "init"], { cwd: nonGhDir, stdout: "pipe", stderr: "pipe" });
		await init.exited;
		const add = Bun.spawn(["git", "remote", "add", "origin", "https://gitlab.com/org/repo.git"], {
			cwd: nonGhDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await add.exited;

		const result = await checkGitHubOrigin(nonGhDir);
		expect(result.passed).toBe(false);
		expect(result.error).toContain("does not point to GitHub");

		rmSync(nonGhDir, { recursive: true, force: true });
	});
});

// T009: checkGhInstalled
describe("checkGhInstalled", () => {
	test("passes when gh is installed", async () => {
		const result = await checkGhInstalled();
		// gh may or may not be installed in test env — just verify structure
		expect(result.required).toBe(true);
		expect(result.name).toBe("GitHub CLI installed");
		if (result.passed) {
			expect(result.error).toBeUndefined();
		} else {
			expect(result.error).toContain("gh CLI is not installed");
		}
	});
});

// T010: checkGhAuth
describe("checkGhAuth", () => {
	test("returns result with correct structure", async () => {
		const result = await checkGhAuth(gitRepoPath);
		expect(result.required).toBe(true);
		expect(result.name).toBe("GitHub CLI authenticated");
		// Can't guarantee auth state in test — just verify structure
		if (!result.passed) {
			expect(result.error).toBeDefined();
		}
	});

	test("fails when no origin remote", async () => {
		const result = await checkGhAuth(nonGitDir);
		expect(result.passed).toBe(false);
		expect(result.error).toContain("no origin remote");
	});

	test("extracts hostname from SSH origin URL", async () => {
		const sshDir = join(testRoot, "ssh-origin");
		mkdirSync(sshDir, { recursive: true });
		const proc = Bun.spawn(["git", "init"], { cwd: sshDir, stdout: "pipe", stderr: "pipe" });
		await proc.exited;
		const add = Bun.spawn(
			["git", "remote", "add", "origin", "git@github.enterprise.com:org/repo.git"],
			{ cwd: sshDir, stdout: "pipe", stderr: "pipe" },
		);
		await add.exited;

		const result = await checkGhAuth(sshDir);
		// Auth will likely fail, but the error message should reference the enterprise hostname
		if (!result.passed && result.error) {
			expect(result.error).toContain("github.enterprise.com");
		}

		rmSync(sshDir, { recursive: true, force: true });
	});
});

// T011: checkSpeckitFiles
describe("checkSpeckitFiles", () => {
	test("passes when all files present", () => {
		const result = checkSpeckitFiles(speckitCompleteDir);
		expect(result.passed).toBe(true);
		expect(result.required).toBe(true);
		expect(result.error).toBeUndefined();
	});

	test("fails with missing files listed", () => {
		const result = checkSpeckitFiles(speckitMissingDir);
		expect(result.passed).toBe(false);
		expect(result.required).toBe(true);
		expect(result.error).toContain("speckit.implement.md");
		expect(result.error).toContain("speckit.specify.md");
		expect(result.error).toContain("speckit.tasks.md");
	});

	test("fails when all files missing", () => {
		const result = checkSpeckitFiles(nonGitDir);
		expect(result.passed).toBe(false);
		expect(result.error).toContain("Missing .claude/commands/ files");
	});
});

// T012: checkClaudeCli
describe("checkClaudeCli", () => {
	test("returns result with correct structure", async () => {
		const result = await checkClaudeCli();
		expect(result.required).toBe(true);
		expect(result.name).toBe("Claude CLI installed");
		if (!result.passed) {
			expect(result.error).toContain("claude CLI is not installed");
		}
	});
});

// T013: runSetupChecks integration
describe("runSetupChecks", () => {
	test("reports failures for non-git directory", async () => {
		const result = await runSetupChecks(nonGitDir);
		expect(result.passed).toBe(false);
		expect(result.requiredFailures.length).toBeGreaterThan(0);
		// Should include git repo failure
		const gitRepoFailure = result.requiredFailures.find((f) => f.name === "Git repository");
		expect(gitRepoFailure).toBeDefined();
		expect(gitRepoFailure?.passed).toBe(false);
	});

	test("collects all required failures (not just first)", async () => {
		const result = await runSetupChecks(nonGitDir);
		// Should have multiple failures (git repo, speckit files, etc.)
		expect(result.requiredFailures.length).toBeGreaterThanOrEqual(2);
	});

	test("all checks have required: true for required checks", async () => {
		const result = await runSetupChecks(nonGitDir);
		const requiredChecks = result.checks.filter((c) => c.required);
		expect(requiredChecks.length).toBe(7);
		for (const check of requiredChecks) {
			expect(check.required).toBe(true);
		}
	});

	// T023: optional-warnings path
	test("populates optionalWarnings when required pass but gitignore entries missing", async () => {
		// gitRepoPath has git, github origin, speckit files — but no .gitignore
		const result = await runSetupChecks(gitRepoPath);
		// gh/claude may not be installed in CI, so only assert optional behavior if required passed
		if (result.passed) {
			expect(result.requiredFailures).toHaveLength(0);
			expect(result.optionalWarnings.length).toBeGreaterThan(0);
			for (const w of result.optionalWarnings) {
				expect(w.required).toBe(false);
				expect(w.passed).toBe(false);
			}
			// checks array should include both required and optional
			const optionalInChecks = result.checks.filter((c) => !c.required);
			expect(optionalInChecks.length).toBeGreaterThan(0);
		}
	});
});

// T022: checkGitignoreEntries
describe("checkGitignoreEntries", () => {
	test("reports all present when gitignore has entries", async () => {
		const dir = join(testRoot, "gitignore-complete");
		mkdirSync(dir, { recursive: true });
		Bun.spawnSync(["git", "init"], { cwd: dir });
		Bun.spawnSync(["git", "config", "core.excludesFile", ""], { cwd: dir });
		writeFileSync(
			join(dir, ".gitignore"),
			"node_modules/\nspecs/\n.worktrees\n.claude\n.specify\n",
		);

		const results = await checkGitignoreEntries(dir);
		for (const r of results) {
			expect(r.passed).toBe(true);
			expect(r.required).toBe(false);
		}

		rmSync(dir, { recursive: true, force: true });
	});

	test("reports missing entries", async () => {
		const dir = join(testRoot, "gitignore-partial");
		mkdirSync(dir, { recursive: true });
		Bun.spawnSync(["git", "init"], { cwd: dir });
		Bun.spawnSync(["git", "config", "core.excludesFile", ""], { cwd: dir });
		writeFileSync(join(dir, ".gitignore"), "node_modules/\nspecs/\n");

		const results = await checkGitignoreEntries(dir);
		const specResult = results.find((r) => r.name === "Gitignore: specs/");
		expect(specResult?.passed).toBe(true);

		const worktreeResult = results.find((r) => r.name === "Gitignore: .worktrees");
		expect(worktreeResult?.passed).toBe(false);
		expect(worktreeResult?.error).toContain(".worktrees");

		rmSync(dir, { recursive: true, force: true });
	});

	test(
		"reports already-tracked warning when gitignored but tracked",
		async () => {
			const dir = join(testRoot, "gitignore-tracked");
			mkdirSync(dir, { recursive: true });
			Bun.spawnSync(["git", "init"], { cwd: dir });
			Bun.spawnSync(["git", "config", "core.excludesFile", ""], { cwd: dir });
			// Create and track specs/ before adding it to .gitignore
			mkdirSync(join(dir, "specs"), { recursive: true });
			writeFileSync(join(dir, "specs", "test.md"), "test");
			Bun.spawnSync(["git", "add", "specs"], { cwd: dir });
			Bun.spawnSync(["git", "commit", "-m", "add specs"], { cwd: dir });
			writeFileSync(
				join(dir, ".gitignore"),
				"node_modules/\nspecs/\n.worktrees\n.claude\n.specify\n",
			);

			const results = await checkGitignoreEntries(dir);
			const specResult = results.find((r) => r.name === "Gitignore: specs/");
			expect(specResult?.passed).toBe(false);
			expect(specResult?.error).toContain("already tracked");
			expect(specResult?.error).toContain("git rm");

			rmSync(dir, { recursive: true, force: true });
		},
		{ timeout: 15_000 },
	);

	test("reports all missing when no .gitignore", async () => {
		const results = await checkGitignoreEntries(nonGitDir);
		for (const r of results) {
			expect(r.passed).toBe(false);
			expect(r.required).toBe(false);
		}
	});
});
