import { toErrorMessage } from "./errors";
import { defaultSpawn, readStream, type SpawnLike } from "./spawn-utils";
import type { SyncResult } from "./types";
import type { WorkflowEngine } from "./workflow-engine";

export async function syncRepo(
	targetRepo: string,
	worktreePath: string | null,
	engine: WorkflowEngine,
	_workflowId: string,
	onOutput: (msg: string) => void,
	runner?: SpawnLike,
): Promise<SyncResult> {
	const spawn = runner?.spawn ?? defaultSpawn();

	let pulled = false;
	let skipped = false;
	let worktreeRemoved = false;
	let warning: string | null = null;

	// Check for uncommitted changes
	onOutput(`[git] git status --porcelain | cwd=${targetRepo}`);
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
		onOutput(`[git] git pull --ff-only origin master | cwd=${targetRepo}`);
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
			const msg = toErrorMessage(err);
			const wtWarning = `Worktree removal failed: ${msg}`;
			warning = warning ? `${warning}; ${wtWarning}` : wtWarning;
			onOutput(wtWarning);
		}
	}

	return { pulled, skipped, worktreeRemoved, warning };
}
