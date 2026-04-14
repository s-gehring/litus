import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { gitSpawn } from "./git-logger";
import { looksLikeGitUrl, parseGitHubUrl } from "./git-url";

export interface TargetRepoValidation {
	valid: boolean;
	error?: string;
	/**
	 * Local filesystem path when `kind === "path"`. For `kind === "url"` callers
	 * should consume `owner`/`repo` instead — do not treat this as a path.
	 */
	effectivePath: string;
	/** "url" — remote GitHub URL (not yet cloned); "path" — local filesystem path. */
	kind?: "url" | "path";
	/** Parsed owner/repo for `kind === "url"` — saves callers from re-parsing. */
	owner?: string;
	repo?: string;
	/** Machine-readable error code (currently only `non-github-url`). */
	code?: "non-github-url";
}

/** Expand ~ to home directory and normalize separators. */
export function normalizePath(raw: string): string {
	let p = raw.trim();
	if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
		p = homedir() + p.slice(1);
	}
	return normalize(p);
}

export async function validateTargetRepository(
	path: string | undefined,
): Promise<TargetRepoValidation> {
	if (!path?.trim()) {
		return {
			valid: false,
			error: "Target repository path is required",
			effectivePath: "",
		};
	}

	const raw = path.trim();

	// URL branch: accept GitHub URLs without touching the filesystem; reject other hosts.
	if (looksLikeGitUrl(raw)) {
		const parsed = parseGitHubUrl(raw);
		if (parsed) {
			return {
				valid: true,
				effectivePath: raw,
				kind: "url",
				owner: parsed.owner,
				repo: parsed.repo,
			};
		}
		return {
			valid: false,
			error: "Only GitHub URLs are supported — use a local folder path for other hosts.",
			effectivePath: raw,
			code: "non-github-url",
		};
	}

	const trimmed = normalizePath(path);

	// Must be absolute
	if (!isAbsolute(trimmed)) {
		return {
			valid: false,
			error: "Target repository must be an absolute path",
			effectivePath: trimmed,
		};
	}

	// Must exist and be a directory
	try {
		const st = await stat(trimmed);
		if (!st.isDirectory()) {
			return {
				valid: false,
				error: `Target repository path is not a directory: ${trimmed}`,
				effectivePath: trimmed,
			};
		}
	} catch {
		return {
			valid: false,
			error: `Target repository path does not exist: ${trimmed}`,
			effectivePath: trimmed,
		};
	}

	// Must be a git repository
	try {
		const result = await gitSpawn(["git", "rev-parse", "--git-dir"], {
			cwd: trimmed,
			extra: { target: trimmed },
		});
		if (result.code !== 0) {
			return {
				valid: false,
				error: `Target repository is not a git repository: ${trimmed}`,
				effectivePath: trimmed,
			};
		}
	} catch {
		return {
			valid: false,
			error: `Target repository is not a git repository: ${trimmed}`,
			effectivePath: trimmed,
		};
	}

	return { valid: true, effectivePath: trimmed, kind: "path" };
}
