import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type TempDirCallback = (dir: string) => Promise<void> | void;

const CLEANUP_MAX_RETRIES = 3;
const CLEANUP_RETRY_DELAY_MS = 100;

async function retryCleanup(dir: string): Promise<void> {
	for (let attempt = 1; attempt <= CLEANUP_MAX_RETRIES; attempt++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch {
			if (attempt < CLEANUP_MAX_RETRIES) {
				await new Promise((r) => setTimeout(r, CLEANUP_RETRY_DELAY_MS));
			} else {
				console.warn(
					`[test-infra] Failed to clean up temp dir after ${CLEANUP_MAX_RETRIES} attempts: ${dir}`,
				);
			}
		}
	}
}

/**
 * Create a temp directory, pass it to the callback, and clean up after.
 * Retries cleanup up to 3 times with 100ms delay for Windows file-locking.
 */
export async function withTempDir(callback: TempDirCallback): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "crab-test-"));
	try {
		await callback(dir);
	} finally {
		await retryCleanup(dir);
	}
}

const GIT_TEST_ENV = {
	GIT_AUTHOR_NAME: "Test Author",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test Author",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

/**
 * Create a temp directory with a valid git repo (initialized with one empty commit).
 * Uses deterministic author info. Caller is responsible for cleanup.
 */
export async function createTempRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "crab-repo-"));

	const init = Bun.spawn(["git", "init"], {
		cwd: dir,
		env: { ...process.env, ...GIT_TEST_ENV },
		stdout: "ignore",
		stderr: "ignore",
	});
	const initCode = await init.exited;
	if (initCode !== 0) {
		throw new Error(`git init failed with exit code ${initCode}`);
	}

	const commit = Bun.spawn(["git", "commit", "--allow-empty", "-m", "init"], {
		cwd: dir,
		env: { ...process.env, ...GIT_TEST_ENV },
		stdout: "ignore",
		stderr: "ignore",
	});
	const commitCode = await commit.exited;
	if (commitCode !== 0) {
		throw new Error(`git commit failed with exit code ${commitCode}`);
	}

	return dir;
}
