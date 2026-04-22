import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnClaude } from "./claude-spawn";
import { gitSpawn } from "./git-logger";
import { readStream } from "./spawn-utils";
import type { SetupCheckResult, SetupResult } from "./types";

const SPECKIT_VERSION = "v0.6.0";

async function runCommand(
	cmd: string[],
	cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		return await gitSpawn(cmd, { cwd, extra: { check: "setup" } });
	} catch {
		return { code: 1, stdout: "", stderr: `Failed to execute: ${cmd[0]}` };
	}
}

export async function checkGitInstalled(): Promise<SetupCheckResult> {
	const result = await runCommand(["git", "--version"]);
	return {
		name: "Git installed",
		passed: result.code === 0,
		error:
			result.code !== 0
				? "git is not installed or not on PATH. Install it from https://git-scm.com/"
				: undefined,
		required: true,
	};
}

export async function checkIsGitRepo(targetDir: string): Promise<SetupCheckResult> {
	const result = await runCommand(["git", "rev-parse", "--is-inside-work-tree"], targetDir);
	return {
		name: "Git repository",
		passed: result.code === 0,
		error: result.code !== 0 ? `Target directory is not a git repository: ${targetDir}` : undefined,
		required: true,
	};
}

export async function checkGitHubOrigin(targetDir: string): Promise<SetupCheckResult> {
	const result = await runCommand(["git", "remote", "get-url", "origin"], targetDir);
	if (result.code !== 0) {
		return {
			name: "GitHub origin remote",
			passed: false,
			error: "No GitHub remote named 'origin' found. Add one with: git remote add origin <url>",
			required: true,
		};
	}
	const url = result.stdout.toLowerCase();
	if (!url.includes("github")) {
		return {
			name: "GitHub origin remote",
			passed: false,
			error: `Origin remote does not point to GitHub: ${result.stdout}`,
			required: true,
		};
	}
	return { name: "GitHub origin remote", passed: true, required: true };
}

export async function checkGhInstalled(): Promise<SetupCheckResult> {
	const result = await runCommand(["gh", "--version"]);
	return {
		name: "GitHub CLI installed",
		passed: result.code === 0,
		error:
			result.code !== 0
				? "gh CLI is not installed or not on PATH. Install it from https://cli.github.com/"
				: undefined,
		required: true,
	};
}

export async function checkGhAuth(targetDir: string): Promise<SetupCheckResult> {
	// Extract hostname from origin URL
	const originResult = await runCommand(["git", "remote", "get-url", "origin"], targetDir);
	if (originResult.code !== 0) {
		return {
			name: "GitHub CLI authenticated",
			passed: false,
			error: "Cannot check gh auth — no origin remote configured",
			required: true,
		};
	}

	let hostname = "github.com";
	const url = originResult.stdout;
	// Handle SSH: git@github.example.com:org/repo.git
	const sshMatch = url.match(/@([^:]+):/);
	if (sshMatch) {
		hostname = sshMatch[1];
	} else {
		// Handle HTTPS: https://github.example.com/org/repo.git
		const httpsMatch = url.match(/https?:\/\/([^/]+)/);
		if (httpsMatch) {
			hostname = httpsMatch[1];
		}
	}

	const result = await runCommand(["gh", "auth", "status", "--hostname", hostname]);
	return {
		name: "GitHub CLI authenticated",
		passed: result.code === 0,
		error:
			result.code !== 0
				? `gh is not authenticated for ${hostname}. Run: gh auth login --hostname ${hostname}`
				: undefined,
		required: true,
	};
}

export async function checkUvInstalled(): Promise<SetupCheckResult> {
	const result = await runCommand(["uv", "--version"]);
	return {
		name: "uv installed",
		passed: result.code === 0,
		error:
			result.code !== 0
				? "uv is not installed or not on PATH. Install it from https://docs.astral.sh/uv/"
				: undefined,
		required: true,
	};
}

/** Speckit prompt names produced by `specify init` (not bundled with the app). */
const SPECKIT_INIT_NAMES = ["clarify", "implement", "plan", "specify", "tasks"];

/** Names of prompts bundled with the app that get auto-installed when speckit is already present. */
const BUNDLED_SPECKIT_NAMES = ["review", "implementreview"];

const BUNDLED_DIR = join(import.meta.dir, "bundled-skills");

function skillExists(skillsDir: string, name: string): boolean {
	return existsSync(join(skillsDir, `speckit-${name}`, "SKILL.md"));
}

function installBundledSkills(skillsDir: string): string[] {
	const installed: string[] = [];
	for (const name of BUNDLED_SPECKIT_NAMES) {
		if (!skillExists(skillsDir, name)) {
			const target = join(skillsDir, `speckit-${name}`);
			mkdirSync(target, { recursive: true });
			cpSync(join(BUNDLED_DIR, `speckit-${name}`), target, { recursive: true });
			installed.push(name);
		}
	}
	return installed;
}

/** Check whether all speckit init skills exist in the target directory. */
export function hasSpeckitSkills(targetDir: string): boolean {
	const skillsDir = join(targetDir, ".claude", "skills");
	return SPECKIT_INIT_NAMES.every((name) => skillExists(skillsDir, name));
}

/**
 * Ensure speckit skills are present in `targetDir`.
 *
 * - If speckit skills already exist, install only the bundled extras and return `null`.
 * - If no speckit skills exist, run `uvx specify init` and return the process result.
 */
export async function ensureSpeckitSkills(targetDir: string): Promise<{
	installed: boolean;
	initResult: { code: number; stdout: string; stderr: string } | null;
}> {
	if (hasSpeckitSkills(targetDir)) {
		const skillsDir = join(targetDir, ".claude", "skills");
		installBundledSkills(skillsDir);
		return { installed: true, initResult: null };
	}

	const scriptType = process.platform === "win32" ? "ps" : "sh";
	const result = await runCommand(
		[
			"uvx",
			"--from",
			`git+https://github.com/github/spec-kit.git@${SPECKIT_VERSION}`,
			"specify",
			"init",
			"--here",
			"--ai",
			"claude",
			"--script",
			scriptType,
			"--force",
			"--no-git",
		],
		targetDir,
	);
	if (result.code === 0) {
		const skillsDir = join(targetDir, ".claude", "skills");
		installBundledSkills(skillsDir);
	}
	return { installed: result.code === 0, initResult: result };
}

export async function checkClaudeCli(): Promise<SetupCheckResult> {
	let code = 1;
	try {
		const proc = spawnClaude(["--version"]);
		code = await proc.exited;
		// Drain the pipes so Bun doesn't leak the process handle.
		await readStream(proc.stdout);
		await readStream(proc.stderr);
	} catch {
		code = 1;
	}
	return {
		name: "Claude CLI installed",
		passed: code === 0,
		error:
			code !== 0
				? "claude CLI is not installed or not on PATH. Install it from https://docs.anthropic.com/en/docs/claude-code"
				: undefined,
		required: true,
	};
}

const GITIGNORE_ENTRIES = ["specs/", ".worktrees", ".claude", ".specify"];

export async function checkGitignoreEntries(targetDir: string): Promise<SetupCheckResult[]> {
	return Promise.all(
		GITIGNORE_ENTRIES.map(async (entry) => {
			const result = await runCommand(["git", "check-ignore", entry], targetDir);
			if (result.code === 0) {
				return { name: `Gitignore: ${entry}`, passed: true, required: false };
			}
			// Pattern not effective — check if it exists but is overridden by tracked files
			const noIndex = await runCommand(["git", "check-ignore", "--no-index", entry], targetDir);
			if (noIndex.code === 0) {
				return {
					name: `Gitignore: ${entry}`,
					passed: false,
					error: `"${entry}" is gitignored but already tracked — run "git rm -r --cached ${entry}" to untrack it`,
					required: false,
				};
			}
			return {
				name: `Gitignore: ${entry}`,
				passed: false,
				error: `"${entry}" is not listed in .gitignore`,
				required: false,
			};
		}),
	);
}

export async function runSetupChecks(targetDir: string): Promise<SetupResult> {
	// Run all required checks
	const [gitInstalled, isGitRepo, ghInstalled, claudeCli, uvInstalled] = await Promise.all([
		checkGitInstalled(),
		checkIsGitRepo(targetDir),
		checkGhInstalled(),
		checkClaudeCli(),
		checkUvInstalled(),
	]);

	// Only run origin/auth checks if git repo check passed
	let gitHubOrigin: SetupCheckResult;
	let ghAuth: SetupCheckResult;
	if (isGitRepo.passed) {
		[gitHubOrigin, ghAuth] = await Promise.all([
			checkGitHubOrigin(targetDir),
			checkGhAuth(targetDir),
		]);
	} else {
		gitHubOrigin = {
			name: "GitHub origin remote",
			passed: false,
			error: "Skipped — not a git repository",
			required: true,
		};
		ghAuth = {
			name: "GitHub CLI authenticated",
			passed: false,
			error: "Skipped — not a git repository",
			required: true,
		};
	}

	const requiredChecks = [
		gitInstalled,
		isGitRepo,
		gitHubOrigin,
		ghInstalled,
		ghAuth,
		uvInstalled,
		claudeCli,
	];

	const requiredFailures = requiredChecks.filter((c) => !c.passed);
	const passed = requiredFailures.length === 0;

	// Only run optional checks if all required checks passed
	const optionalChecks = passed ? await checkGitignoreEntries(targetDir) : [];
	const optionalWarnings = optionalChecks.filter((c) => !c.passed);

	return {
		passed,
		checks: [...requiredChecks, ...optionalChecks],
		requiredFailures,
		optionalWarnings,
	};
}
