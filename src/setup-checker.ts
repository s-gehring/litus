import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SetupCheckResult, SetupResult } from "./types";

async function runCommand(
	cmd: string[],
	cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const proc = Bun.spawn(cmd, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		const stdout = await new Response(proc.stdout as ReadableStream).text();
		const stderr = await new Response(proc.stderr as ReadableStream).text();
		return { code, stdout: stdout.trim(), stderr: stderr.trim() };
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
	}
	// Handle HTTPS: https://github.example.com/org/repo.git
	const httpsMatch = url.match(/https?:\/\/([^/]+)/);
	if (httpsMatch) {
		hostname = httpsMatch[1];
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

const SPECKIT_FILES = [
	"speckit.clarify.md",
	"speckit.implement.md",
	"speckit.plan.md",
	"speckit.specify.md",
	"speckit.tasks.md",
	"speckit.review.md",
	"speckit.implementreview.md",
];

export function checkSpeckitFiles(targetDir: string): SetupCheckResult {
	const claudeDir = join(targetDir, ".claude");
	const missing: string[] = [];
	for (const file of SPECKIT_FILES) {
		const filePath = join(claudeDir, file);
		try {
			readFileSync(filePath);
		} catch {
			missing.push(file);
		}
	}
	return {
		name: "Speckit prompt files",
		passed: missing.length === 0,
		error: missing.length > 0 ? `Missing .claude/ files: ${missing.join(", ")}` : undefined,
		required: true,
	};
}

export async function checkClaudeCli(): Promise<SetupCheckResult> {
	const result = await runCommand(["claude", "--version"]);
	return {
		name: "Claude CLI installed",
		passed: result.code === 0,
		error:
			result.code !== 0
				? "claude CLI is not installed or not on PATH. Install it from https://docs.anthropic.com/en/docs/claude-code"
				: undefined,
		required: true,
	};
}

const GITIGNORE_ENTRIES = ["specs/", ".worktrees", ".claude", ".specify"];

export function checkGitignoreEntries(targetDir: string): SetupCheckResult[] {
	let lines: string[];
	try {
		const content = readFileSync(join(targetDir, ".gitignore"), "utf-8");
		lines = content
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#"));
	} catch {
		// No .gitignore file — all entries are missing
		return GITIGNORE_ENTRIES.map((entry) => ({
			name: `Gitignore: ${entry}`,
			passed: false,
			error: `"${entry}" is not listed in .gitignore`,
			required: false,
		}));
	}

	return GITIGNORE_ENTRIES.map((entry) => {
		// Check if any line matches the entry (with or without trailing slash)
		const found = lines.some(
			(line) => line === entry || line === entry.replace(/\/$/, "") || line === `${entry}/`,
		);
		return {
			name: `Gitignore: ${entry}`,
			passed: found,
			error: found ? undefined : `"${entry}" is not listed in .gitignore`,
			required: false,
		};
	});
}

export async function runSetupChecks(targetDir: string): Promise<SetupResult> {
	// Run all required checks
	const [gitInstalled, isGitRepo, ghInstalled, claudeCli] = await Promise.all([
		checkGitInstalled(),
		checkIsGitRepo(targetDir),
		checkGhInstalled(),
		checkClaudeCli(),
	]);

	const speckitFiles = checkSpeckitFiles(targetDir);

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
		speckitFiles,
		claudeCli,
	];

	const requiredFailures = requiredChecks.filter((c) => !c.passed);
	const passed = requiredFailures.length === 0;

	// Only run optional checks if all required checks passed
	let optionalWarnings: SetupCheckResult[] = [];
	if (passed) {
		const optionalChecks = checkGitignoreEntries(targetDir);
		optionalWarnings = optionalChecks.filter((c) => !c.passed);
	}

	return {
		passed,
		checks: [...requiredChecks, ...(passed ? checkGitignoreEntries(targetDir) : [])],
		requiredFailures,
		optionalWarnings,
	};
}
