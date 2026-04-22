import { gitSpawn } from "./git-logger";
import { logger } from "./logger";

export const CLAUDE_MD_GUARD_BASE_REF = "origin/master";

export type ClaudeMdGuardResult =
	| { outcome: "unchanged" }
	| {
			outcome: "restored";
			action: "content-replaced" | "removed" | "recreated";
			commitSha: string;
	  }
	| { outcome: "no-merge-base" };

const CLAUDE_MD = "CLAUDE.md";
const RESTORE_COMMIT_MESSAGE = "chore: restore CLAUDE.md to pre-branch state";
const MISSING_FILE_PATTERN = /exists on disk, but not in|does not exist|path .* does not exist/i;

async function readBlobAtRef(cwd: string, ref: string): Promise<string | null> {
	const res = await gitSpawn(["git", "show", `${ref}:${CLAUDE_MD}`], { cwd });
	if (res.code === 0) return res.stdout;
	if (MISSING_FILE_PATTERN.test(res.stderr)) return null;
	throw new Error(
		`claude-md-guard: could not read CLAUDE.md at ${ref}: ${res.stderr || `exit ${res.code}`}`,
	);
}

/**
 * Inspect the worktree's CLAUDE.md at HEAD against the version at the merge-base
 * of HEAD and `origin/master`. If they differ (added / removed / content changed),
 * restore the merge-base version and append a single standalone `chore:` commit.
 *
 * Only touches the repo-root CLAUDE.md. Never amends, squashes, or force-pushes.
 * Throws on any unexpected git failure (FR-007).
 */
export async function guardClaudeMd(cwd: string): Promise<ClaudeMdGuardResult> {
	const fetchRes = await gitSpawn(["git", "fetch", "origin", "master"], { cwd });
	if (fetchRes.code !== 0) {
		logger.warn(
			`[claude-md-guard] git fetch origin master failed (exit ${fetchRes.code}); using cached ref`,
		);
	}

	const mergeBase = await gitSpawn(["git", "merge-base", "HEAD", CLAUDE_MD_GUARD_BASE_REF], {
		cwd,
	});
	if (mergeBase.code !== 0) {
		// `git merge-base` exits 1 with empty stdout+stderr only when the histories
		// are disjoint. Any other non-zero (notably 128 "Not a valid object name"
		// when origin/master is missing) must surface as a thrown error so
		// `handleStepError` blocks the push (FR-007 / SC-004).
		if (mergeBase.code === 1 && mergeBase.stdout.trim() === "" && mergeBase.stderr.trim() === "") {
			return { outcome: "no-merge-base" };
		}
		throw new Error(
			`claude-md-guard: merge-base failed: ${mergeBase.stderr || `exit ${mergeBase.code}`}`,
		);
	}
	const baseSha = mergeBase.stdout.trim();
	if (!baseSha) return { outcome: "no-merge-base" };

	const baseContent = await readBlobAtRef(cwd, baseSha);
	const headContent = await readBlobAtRef(cwd, "HEAD");

	if (baseContent === headContent) return { outcome: "unchanged" };

	let action: "content-replaced" | "removed" | "recreated";
	if (baseContent === null) {
		const rm = await gitSpawn(["git", "rm", "--quiet", CLAUDE_MD], { cwd });
		if (rm.code !== 0) {
			throw new Error(`claude-md-guard: git rm failed: ${rm.stderr || `exit ${rm.code}`}`);
		}
		action = "removed";
	} else {
		// Restore from the merge-base tree directly. `git checkout <sha> -- <path>`
		// writes the blob and stages it in a single step and, crucially, ignores
		// any .gitignore rules — users' global excludes commonly list CLAUDE.md,
		// which would otherwise break `git add CLAUDE.md` in the recreated case.
		const checkout = await gitSpawn(["git", "checkout", baseSha, "--", CLAUDE_MD], { cwd });
		if (checkout.code !== 0) {
			throw new Error(
				`claude-md-guard: git checkout ${baseSha} -- CLAUDE.md failed: ${
					checkout.stderr || `exit ${checkout.code}`
				}`,
			);
		}
		action = headContent === null ? "recreated" : "content-replaced";
	}

	// Pin the commit to CLAUDE.md ONLY (-o / --only). Defends FR-005: even if
	// the agent, a pre-commit hook, or a future caller leaves unrelated files
	// staged, those do NOT get swept into the restore commit.
	const commit = await gitSpawn(["git", "commit", "-o", CLAUDE_MD, "-m", RESTORE_COMMIT_MESSAGE], {
		cwd,
	});
	if (commit.code !== 0) {
		throw new Error(`claude-md-guard: commit failed: ${commit.stderr || `exit ${commit.code}`}`);
	}

	const revParse = await gitSpawn(["git", "rev-parse", "HEAD"], { cwd });
	if (revParse.code !== 0) {
		throw new Error(
			`claude-md-guard: rev-parse HEAD failed: ${revParse.stderr || `exit ${revParse.code}`}`,
		);
	}

	return { outcome: "restored", action, commitSha: revParse.stdout.trim() };
}
