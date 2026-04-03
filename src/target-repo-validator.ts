import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface TargetRepoValidation {
	valid: boolean;
	error?: string;
	effectivePath: string;
}

export async function validateTargetRepository(
	path: string | undefined,
): Promise<TargetRepoValidation> {
	// Empty/whitespace → fall back to CWD
	if (!path || !path.trim()) {
		return { valid: true, effectivePath: process.cwd() };
	}

	const trimmed = path.trim();

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
		const proc = Bun.spawn(["git", "rev-parse", "--git-dir"], {
			cwd: trimmed,
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		if (code !== 0) {
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
