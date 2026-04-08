import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { gitSpawn } from "./git-logger";

export interface TargetRepoValidation {
	valid: boolean;
	error?: string;
	effectivePath: string;
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

	return { valid: true, effectivePath: trimmed };
}
