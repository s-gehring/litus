import type { SyncResult } from "./types";
import type { WorkflowEngine } from "./workflow-engine";

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

export async function syncRepo(
	targetRepo: string,
	worktreePath: string | null,
	engine: WorkflowEngine,
	workflowId: string,
	onOutput: (msg: string) => void,
	runner?: SpawnLike,
): Promise<SyncResult> {
	const spawn =
		runner?.spawn ??
		((args: string[], opts?: Record<string, unknown>) =>
			Bun.spawn(args, opts as Parameters<typeof Bun.spawn>[1]));

	let pulled = false;
	let skipped = false;
	let worktreeRemoved = false;
	let warning: string | null = null;

	// Check for uncommitted changes
	onOutput("Checking for uncommitted changes in target repository...");
	const statusProc = spawn(["git", "status", "--porcelain"], {
		cwd: targetRepo,
		stdout: "pipe",
		stderr: "pipe",
	});

	const statusCode = await statusProc.exited;
	const statusOut = await readStream(statusProc.stdout);

	if (statusCode === 0 && statusOut.trim().length > 0) {
		skipped = true;
		warning = "Uncommitted changes in target repository — skipping pull";
		onOutput(warning);
	} else {
		// Pull latest master
		onOutput("Pulling latest master...");
		const pullProc = spawn(["git", "pull", "--ff-only", "origin", "master"], {
			cwd: targetRepo,
			stdout: "pipe",
			stderr: "pipe",
		});

		const pullCode = await pullProc.exited;
		if (pullCode === 0) {
			pulled = true;
			onOutput("Pull successful");
		} else {
			const stderr = await readStream(pullProc.stderr);
			warning = `Pull failed: ${stderr.trim() || `exit code ${pullCode}`}`;
			onOutput(warning);
		}
	}

	// Remove worktree
	if (worktreePath) {
		onOutput("Removing worktree...");
		try {
			await engine.removeWorktree(worktreePath, targetRepo);
			worktreeRemoved = true;
			onOutput("Worktree removed");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const wtWarning = `Worktree removal failed: ${msg}`;
			warning = warning ? `${warning}; ${wtWarning}` : wtWarning;
			onOutput(wtWarning);
		}
	}

	return { pulled, skipped, worktreeRemoved, warning };
}
