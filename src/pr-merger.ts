import { configStore } from "./config-store";
import { readStream, type SpawnLike } from "./spawn-utils";
import type { MergeResult } from "./types";

const PR_NUMBER_REGEX = /\/pull\/(\d+)$/;
const REPO_REGEX = /github\.com\/([^/]+\/[^/]+)\//;

export function extractPrNumber(prUrl: string): string | null {
	const match = prUrl.match(PR_NUMBER_REGEX);
	return match ? match[1] : null;
}

export function extractRepoFromUrl(prUrl: string): string | null {
	const match = prUrl.match(REPO_REGEX);
	return match ? match[1] : null;
}

function isConflictError(stderr: string): boolean {
	const lower = stderr.toLowerCase();
	return (
		lower.includes("merge conflict") || lower.includes("not mergeable") || lower.includes("405")
	);
}

export async function mergePr(
	prUrl: string,
	worktreePath: string,
	onOutput: (msg: string) => void,
	runner?: SpawnLike,
): Promise<MergeResult> {
	const spawn =
		runner?.spawn ??
		((args: string[], opts?: Record<string, unknown>) =>
			Bun.spawn(args, opts as Parameters<typeof Bun.spawn>[1]));

	const prNumber = extractPrNumber(prUrl);
	const repo = extractRepoFromUrl(prUrl);
	if (!prNumber || !repo) {
		return {
			merged: false,
			alreadyMerged: false,
			conflict: false,
			error: `Invalid PR URL: ${prUrl}`,
		};
	}

	// Check PR state first
	onOutput(`[git] gh pr view ${prUrl} --json state | cwd=${worktreePath}`);
	const viewProc = spawn(["gh", "pr", "view", prUrl, "--json", "state"], {
		cwd: worktreePath,
		stdout: "pipe",
		stderr: "pipe",
	});

	const viewCode = await viewProc.exited;
	if (viewCode === 0) {
		const viewOut = await readStream(viewProc.stdout);
		try {
			const state = JSON.parse(viewOut);
			if (state.state === "MERGED") {
				onOutput("PR is already merged");
				return { merged: false, alreadyMerged: true, conflict: false, error: null };
			}
		} catch {
			// Parse error — continue with merge attempt
		}
	}

	// Attempt squash-merge
	onOutput(
		`[git] gh pr merge ${prNumber} --squash --delete-branch --repo ${repo} | cwd=${worktreePath}`,
	);
	const mergeProc = spawn(
		["gh", "pr", "merge", prNumber, "--squash", "--delete-branch", "--repo", repo],
		{
			cwd: worktreePath,
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	const mergeCode = await mergeProc.exited;
	if (mergeCode === 0) {
		onOutput("PR merged successfully");
		return { merged: true, alreadyMerged: false, conflict: false, error: null };
	}

	const stderr = await readStream(mergeProc.stderr);

	if (stderr.toLowerCase().includes("already been merged")) {
		onOutput("PR was already merged");
		return { merged: false, alreadyMerged: true, conflict: false, error: null };
	}

	if (isConflictError(stderr)) {
		onOutput("Merge conflict detected");
		return { merged: false, alreadyMerged: false, conflict: true, error: null };
	}

	return {
		merged: false,
		alreadyMerged: false,
		conflict: false,
		error: stderr.trim() || `exit code ${mergeCode}`,
	};
}

const MERGE_CONFLICT_COMMIT_MSG = "chore: resolve merge conflicts with master";

async function ensureCommittedAndPushed(
	cwd: string,
	onOutput: (msg: string) => void,
	spawn: SpawnLike["spawn"],
): Promise<void> {
	// Check for uncommitted changes (staged + unstaged + untracked)
	const statusProc = spawn(["git", "status", "--porcelain"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	await statusProc.exited;
	const statusOut = await readStream(statusProc.stdout);

	if (statusOut.trim() !== "") {
		onOutput("Detected uncommitted changes after Claude CLI — committing them");

		// Check if last commit is already the merge-conflict commit
		const logProc = spawn(["git", "log", "-1", "--format=%s"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		await logProc.exited;
		const lastMsg = (await readStream(logProc.stdout)).trim();

		// Stage everything
		const addProc = spawn(["git", "add", "."], { cwd, stdout: "pipe", stderr: "pipe" });
		await addProc.exited;

		if (lastMsg === MERGE_CONFLICT_COMMIT_MSG) {
			onOutput("Amending existing merge-conflict commit with remaining changes");
			const amendProc = spawn(["git", "commit", "--amend", "--no-edit"], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			await amendProc.exited;
		} else {
			onOutput("Creating merge-conflict commit for uncommitted changes");
			const commitProc = spawn(["git", "commit", "-m", MERGE_CONFLICT_COMMIT_MSG], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			await commitProc.exited;
		}
	}

	// Always push to ensure remote is up-to-date
	onOutput(`[git] git push | cwd=${cwd}`);
	const pushProc = spawn(["git", "push"], { cwd, stdout: "pipe", stderr: "pipe" });
	const pushCode = await pushProc.exited;
	if (pushCode !== 0) {
		// Force-push needed after amend
		onOutput(`[git] git push --force-with-lease | cwd=${cwd}`);
		const forcePushProc = spawn(["git", "push", "--force-with-lease"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const forceCode = await forcePushProc.exited;
		if (forceCode !== 0) {
			const stderr = await readStream(forcePushProc.stderr);
			throw new Error(`Push failed: ${stderr.trim() || `exit code ${forceCode}`}`);
		}
	}
}

export async function resolveConflicts(
	worktreePath: string,
	specSummary: string,
	onOutput: (msg: string) => void,
	runner?: SpawnLike,
): Promise<void> {
	const spawn =
		runner?.spawn ??
		((args: string[], opts?: Record<string, unknown>) =>
			Bun.spawn(args, opts as Parameters<typeof Bun.spawn>[1]));

	// Fetch and merge master
	onOutput(`[git] git fetch origin master | cwd=${worktreePath}`);
	const fetchProc = spawn(["git", "fetch", "origin", "master"], {
		cwd: worktreePath,
		stdout: "pipe",
		stderr: "pipe",
	});
	await fetchProc.exited;

	onOutput(`[git] git merge origin/master | cwd=${worktreePath}`);
	const mergeProc = spawn(["git", "merge", "origin/master"], {
		cwd: worktreePath,
		stdout: "pipe",
		stderr: "pipe",
	});
	await mergeProc.exited;

	// Build conflict resolution prompt and run Claude CLI
	const config = configStore.get();
	const promptTemplate = config.prompts.mergeConflictResolution;
	const prompt = promptTemplate.replaceAll("${specSummary}", specSummary);
	const model = config.models.mergeConflictResolution;
	const effort = config.efforts.mergeConflictResolution;
	const conflictArgs = [
		"claude",
		"-p",
		prompt,
		"--output-format",
		"stream-json",
		"--verbose",
		"--dangerously-skip-permissions",
		"--effort",
		effort,
	];
	if (model.trim() !== "") {
		conflictArgs.push("--model", model);
	}

	onOutput("Dispatching Claude CLI to resolve conflicts...");
	const claudeProc = spawn(conflictArgs, {
		cwd: worktreePath,
		stdout: "pipe",
		stderr: "pipe",
	});

	const claudeCode = await claudeProc.exited;
	if (claudeCode !== 0) {
		const stderr = await readStream(claudeProc.stderr);
		throw new Error(`Conflict resolution failed: ${stderr.trim() || `exit code ${claudeCode}`}`);
	}

	// Safety net: ensure all changes are committed and pushed
	await ensureCommittedAndPushed(worktreePath, onOutput, spawn as SpawnLike["spawn"]);

	onOutput("Conflict resolution complete, changes pushed");
}
