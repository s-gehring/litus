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

interface SpawnLike {
	spawn: (
		args: string[],
		opts?: Record<string, unknown>,
	) => {
		exited: Promise<number>;
		stdout: ReadableStream | null;
		stderr: ReadableStream | null;
	};
}

async function readStream(stream: ReadableStream | number | null | undefined): Promise<string> {
	if (!stream || typeof stream === "number") return "";
	return new Response(stream as ReadableStream).text();
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
	onOutput("Checking PR state...");
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
	onOutput("Squash-merging PR...");
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
		error: stderr.trim() || `gh pr merge failed with code ${mergeCode}`,
	};
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
	onOutput("Fetching origin master...");
	const fetchProc = spawn(["git", "fetch", "origin", "master"], {
		cwd: worktreePath,
		stdout: "pipe",
		stderr: "pipe",
	});
	await fetchProc.exited;

	onOutput("Merging origin/master into feature branch...");
	const mergeProc = spawn(["git", "merge", "origin/master"], {
		cwd: worktreePath,
		stdout: "pipe",
		stderr: "pipe",
	});
	await mergeProc.exited;

	// Build conflict resolution prompt and run Claude CLI
	const prompt = `The feature branch has merge conflicts with master. Resolve all merge conflicts in this repository.

Feature summary: ${specSummary}

Steps:
1. Find all files with conflict markers (<<<<<<< / ======= / >>>>>>>)
2. Resolve each conflict by keeping the correct combination of both sides
3. Run: git add .
4. Run: git commit -m "chore: resolve merge conflicts with master"
5. Run: git push`;

	onOutput("Dispatching Claude CLI to resolve conflicts...");
	const claudeProc = spawn(
		[
			"claude",
			"-p",
			prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
		],
		{
			cwd: worktreePath,
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	const claudeCode = await claudeProc.exited;
	if (claudeCode !== 0) {
		const stderr = await readStream(claudeProc.stderr);
		throw new Error(`Conflict resolution failed: ${stderr.trim() || `exit code ${claudeCode}`}`);
	}

	onOutput("Conflict resolution complete, changes pushed");
}
