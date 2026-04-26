import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitSpawn } from "./git-logger";
import { logger } from "./logger";

export const PROJECT_CLAUDEMD_SEPARATOR = "\n\n---\n\n";

export interface AppendResult {
	outcome: "appended" | "skipped" | "no-project" | "no-main";
}

export interface SkipWorktreeResult {
	outcome: "marked" | "not-tracked";
}

/** Resolve the main worktree root for a given spec-worktree path.
 *  Returns null if resolution fails (not a git repo, orphaned, etc.). */
export async function resolveMainWorktreeRoot(specWorktree: string): Promise<string | null> {
	try {
		const result = await gitSpawn(["git", "worktree", "list", "--porcelain"], {
			cwd: specWorktree,
		});
		if (result.code !== 0) return null;
		for (const line of result.stdout.split("\n")) {
			if (line.startsWith("worktree ")) {
				const path = line.slice("worktree ".length).trim();
				return path.length > 0 ? path : null;
			}
		}
		return null;
	} catch {
		return null;
	}
}

async function readIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		logger.warn(`[claude-md-merger] Could not read ${path}: ${(err as Error).message}`);
		return null;
	}
}

async function atomicWrite(path: string, data: string): Promise<void> {
	const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, data, "utf-8");
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

/** Append project CLAUDE.md content (from the main worktree) to the generated
 *  CLAUDE.md at the root of the spec worktree. Idempotent.
 *
 *  Possible `outcome` values (see `contracts/append-project-claudemd.md`):
 *  - `"appended"`  – content was appended (or re-appended when a stale suffix existed).
 *  - `"skipped"`   – generated file already ends with the expected suffix; no write.
 *  - `"no-project"` – main worktree has no readable/non-empty CLAUDE.md; no write.
 *  - `"no-main"`   – main worktree could not be resolved (non-git, orphaned, etc.);
 *                     no write.
 *
 *  Throws only if the generated CLAUDE.md is missing (setup precondition violated)
 *  or if the atomic write itself fails. */
export async function appendProjectClaudeMd(specWorktree: string): Promise<AppendResult> {
	const mainRoot = await resolveMainWorktreeRoot(specWorktree);
	if (!mainRoot) return { outcome: "no-main" };

	const projectPath = join(mainRoot, "CLAUDE.md");
	const projectBytes = await readIfExists(projectPath);
	if (projectBytes === null || projectBytes.length === 0) {
		return { outcome: "no-project" };
	}

	const generatedPath = join(specWorktree, "CLAUDE.md");
	const generated = await readFile(generatedPath, "utf-8");

	const suffix = PROJECT_CLAUDEMD_SEPARATOR + projectBytes;
	if (generated.endsWith(suffix)) {
		return { outcome: "skipped" };
	}

	await atomicWrite(generatedPath, generated + suffix);
	return { outcome: "appended" };
}

/** Mark CLAUDE.md as `--skip-worktree` in the spec worktree's index, so that
 *  the working-tree version (assembled by `appendProjectClaudeMd`) is invisible
 *  to `git status`/`git add`/`git commit -a`. This prevents the assembled
 *  CLAUDE.md from ever being committed on the spec branch — defense in depth
 *  alongside `claude-md-guard.ts`, which only catches modifications that
 *  *already* reached HEAD.
 *
 *  Returns `{ outcome: "marked" }` when the flag is set, or
 *  `{ outcome: "not-tracked" }` when CLAUDE.md is absent from the index (the
 *  project's master had no CLAUDE.md to inherit from). The caller logs but
 *  does not fail in the latter case — there is nothing tracked to leak. */
export async function markClaudeMdSkipWorktree(specWorktree: string): Promise<SkipWorktreeResult> {
	const result = await gitSpawn(["git", "update-index", "--skip-worktree", "CLAUDE.md"], {
		cwd: specWorktree,
	});
	if (result.code === 0) return { outcome: "marked" };

	// `git update-index --skip-worktree` exits non-zero when the path is not
	// already tracked in the index. That is the only expected failure mode in
	// our flow (worktree just created from master that lacks CLAUDE.md). Any
	// other stderr would still surface here for diagnosis.
	logger.info(
		`[claude-md-merger] skip-worktree not applied — CLAUDE.md not in index (exit ${result.code}): ${result.stderr}`,
	);
	return { outcome: "not-tracked" };
}
