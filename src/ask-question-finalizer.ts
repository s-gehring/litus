// ── Ask-question finalizer ───────────────────────────────
//
// Helpers for the terminal `finalize` step on an ask-question workflow:
// snapshot the markdown artifacts, remove the worktree, and let the
// orchestrator transition the workflow to `completed`.
//
// Snapshotting and worktree removal are split so the orchestrator can
// emit a per-action system text entry to the step output and surface
// failures with precise error messages.

import { toErrorMessage } from "./errors";
import { gitSpawn } from "./git-logger";
import { logger } from "./logger";

export type RemoveWorktreeResult =
	| { kind: "ok" }
	| { kind: "missing" } // worktree was already gone (treated as success)
	| { kind: "error"; message: string };

/**
 * Remove the workflow's worktree via `git worktree remove --force`. The
 * orchestrator owns the workflow state mutation that follows on success
 * (`worktreePath = null`, status → completed). Treats "already gone" as
 * idempotent success so retries don't trip on a partial-failure cleanup.
 */
export async function removeWorktree(
	worktreePath: string,
	targetRepository: string,
): Promise<RemoveWorktreeResult> {
	try {
		const result = await gitSpawn(["git", "worktree", "remove", worktreePath, "--force"], {
			cwd: targetRepository,
			extra: { worktree: worktreePath },
		});
		if (result.code === 0) return { kind: "ok" };
		const stderr = result.stderr || "";
		if (
			/is not a working tree/i.test(stderr) ||
			/does not exist/i.test(stderr) ||
			/No such file or directory/i.test(stderr)
		) {
			return { kind: "missing" };
		}
		return {
			kind: "error",
			message: stderr || `git worktree remove exited with code ${result.code}`,
		};
	} catch (err) {
		const msg = toErrorMessage(err);
		logger.warn(`[finalize] worktree remove threw: ${msg}`);
		return { kind: "error", message: msg };
	}
}
