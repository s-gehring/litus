import { rm as fsRm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AsyncLock } from "./async-lock";
import { gitSpawn } from "./git-logger";
import { canonicalKey, parseGitHubUrl } from "./git-url";
import { logger } from "./logger";
import type { Workflow } from "./types";

export type CloneStep = "resolving" | "cloning" | "fetching" | "ready";

export interface AcquireCallbacks {
	onStart?: (owner: string, repo: string, reused: boolean) => void;
	onProgress?: (step: CloneStep, message?: string) => void;
}

export interface AcquireResult {
	owner: string;
	repo: string;
	path: string;
	reused: boolean;
	fallbackUsed?: "git";
}

export interface RunCmdResult {
	code: number;
	stdout: string;
	stderr: string;
	/** true when the binary itself could not be found (ENOENT on spawn). */
	missing: boolean;
}

export interface RepoStoreDeps {
	baseDir: string;
	runCmd: (cmd: string[], cwd?: string) => Promise<RunCmdResult>;
	rm: (path: string) => Promise<void>;
	pathExists: (path: string) => Promise<boolean>;
}

type ManagedRepoState =
	| { kind: "cloning"; promise: Promise<string>; waiters: number; owner: string; repo: string }
	| { kind: "ready"; path: string; refCount: number; owner: string; repo: string }
	| { kind: "deleting"; promise: Promise<void>; owner: string; repo: string };

export class ManagedRepoStoreError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export class ManagedRepoStore {
	private readonly deps: RepoStoreDeps;
	private readonly states = new Map<string, ManagedRepoState>();
	private readonly locks = new Map<string, AsyncLock>();

	constructor(deps: RepoStoreDeps) {
		this.deps = deps;
	}

	private lockFor(key: string): AsyncLock {
		let l = this.locks.get(key);
		if (!l) {
			l = new AsyncLock();
			this.locks.set(key, l);
		}
		return l;
	}

	/** Test-only introspection. */
	getStateForTest(
		key: string,
	):
		| { kind: "cloning"; waiters: number }
		| { kind: "ready"; refCount: number }
		| { kind: "deleting" }
		| undefined {
		const s = this.states.get(key);
		if (!s) return undefined;
		if (s.kind === "cloning") return { kind: "cloning", waiters: s.waiters };
		if (s.kind === "ready") return { kind: "ready", refCount: s.refCount };
		return { kind: "deleting" };
	}

	async acquire(
		_submissionId: string,
		rawUrl: string,
		callbacks?: AcquireCallbacks,
	): Promise<AcquireResult> {
		const parsed = parseGitHubUrl(rawUrl);
		if (!parsed) {
			throw new ManagedRepoStoreError(
				"non-github-url",
				"Only GitHub URLs are supported — use a local folder path for other hosts.",
			);
		}
		const { owner, repo } = parsed;
		const key = canonicalKey(owner, repo);
		const destPath = join(this.deps.baseDir, owner, repo);

		// Decide what state we're in (under the per-key lock). Four outcomes:
		// - fresh clone (owner path)
		// - waiter on existing clone
		// - ready-reuse (fetch)
		// - wait for deletion then recurse
		for (;;) {
			const decision = await this.lockFor(key).run(async () => {
				const existing = this.states.get(key);
				if (!existing) {
					// Start a fresh clone. Install cloning state synchronously (still under the lock).
					let resolveCloneSuccess!: (path: string) => void;
					let rejectClone!: (err: unknown) => void;
					const clonePromise = new Promise<string>((res, rej) => {
						resolveCloneSuccess = res;
						rejectClone = rej;
					});
					// Prevent unhandled-rejection warnings when there are no waiters.
					clonePromise.catch(() => undefined);
					this.states.set(key, {
						kind: "cloning",
						promise: clonePromise,
						waiters: 1,
						owner,
						repo,
					});
					return {
						role: "owner" as const,
						clonePromise,
						resolveCloneSuccess,
						rejectClone,
					};
				}
				if (existing.kind === "cloning") {
					existing.waiters += 1;
					return { role: "waiter" as const, promise: existing.promise };
				}
				if (existing.kind === "ready") {
					existing.refCount += 1;
					return {
						role: "reuser" as const,
						path: existing.path,
					};
				}
				// deleting — wait and retry
				return { role: "deleted-wait" as const, promise: existing.promise };
			});

			if (decision.role === "deleted-wait") {
				callbacks?.onProgress?.("resolving", "waiting for previous deletion to finish");
				await decision.promise.catch(() => undefined);
				continue; // retry acquisition
			}

			if (decision.role === "waiter") {
				callbacks?.onStart?.(owner, repo, true);
				callbacks?.onProgress?.("resolving", "waiting for in-flight clone");
				callbacks?.onProgress?.("cloning");
				const path = await decision.promise;
				callbacks?.onProgress?.("ready");
				return { owner, repo, path, reused: true };
			}

			if (decision.role === "reuser") {
				callbacks?.onStart?.(owner, repo, true);
				callbacks?.onProgress?.("fetching");
				try {
					const fetchResult = await this.deps.runCmd(
						["git", "fetch", "--all", "--prune"],
						decision.path,
					);
					if (fetchResult.code !== 0) {
						logger.warn(`[managed-repo] git fetch failed for ${key}: ${fetchResult.stderr}`);
					} else {
						logger.info(`[managed-repo] action=fetch owner=${owner} repo=${repo}`);
					}
				} catch (err) {
					logger.warn(`[managed-repo] git fetch errored for ${key}: ${err}`);
				}
				callbacks?.onProgress?.("ready");
				return { owner, repo, path: decision.path, reused: true };
			}

			// Owner role: perform the clone outside the lock
			callbacks?.onStart?.(owner, repo, false);
			callbacks?.onProgress?.("resolving");
			callbacks?.onProgress?.("cloning");
			try {
				const { fallbackUsed } = await this.performClone(owner, repo, rawUrl, destPath);
				logger.info(
					`[managed-repo] action=clone owner=${owner} repo=${repo}${fallbackUsed ? ` fallbackUsed=${fallbackUsed}` : ""}`,
				);
				// Transition cloning → ready under lock; final refCount is `waiters`.
				const finalPath = await this.lockFor(key).run(async () => {
					const current = this.states.get(key);
					const waiters = current?.kind === "cloning" ? current.waiters : 1;
					this.states.set(key, {
						kind: "ready",
						path: destPath,
						refCount: waiters,
						owner,
						repo,
					});
					return destPath;
				});
				decision.resolveCloneSuccess(finalPath);
				callbacks?.onProgress?.("ready");
				return { owner, repo, path: finalPath, reused: false, fallbackUsed };
			} catch (err) {
				// Clean up the cloning entry so a retry can start fresh
				await this.lockFor(key).run(async () => {
					const current = this.states.get(key);
					if (current?.kind === "cloning") this.states.delete(key);
				});
				decision.rejectClone(err);
				throw err;
			}
		}
	}

	private async performClone(
		owner: string,
		repo: string,
		rawUrl: string,
		destPath: string,
	): Promise<{ fallbackUsed?: "git" }> {
		// Try gh first
		const ghResult = await this.deps.runCmd([
			"gh",
			"repo",
			"clone",
			`${owner}/${repo}`,
			destPath,
			"--",
			"--quiet",
		]);

		if (ghResult.code === 0) return {};

		const isGhMissing = ghResult.missing;
		const isAuthError = /not logged in|authentication|gh auth login/i.test(ghResult.stderr);

		if (!isGhMissing && !isAuthError) {
			throw new ManagedRepoStoreError(
				"clone-failed",
				ghResult.stderr || `gh repo clone failed (exit ${ghResult.code})`,
			);
		}

		// Fall back to raw git clone with the user-supplied URL
		const gitResult = await this.deps.runCmd(["git", "clone", rawUrl, destPath]);
		if (gitResult.code !== 0) {
			throw new ManagedRepoStoreError(
				"clone-failed",
				gitResult.stderr || `git clone failed (exit ${gitResult.code})`,
			);
		}
		return { fallbackUsed: "git" };
	}

	/**
	 * Bump the refCount of an already-ready clone without any subprocess work.
	 * Used by the epic flow when a single `acquire` creates N child workflows
	 * that each become independent consumers of the clone.
	 */
	async bumpRefCount(owner: string, repo: string, by: number): Promise<void> {
		if (by <= 0) return;
		const key = canonicalKey(owner, repo);
		await this.lockFor(key).run(async () => {
			const current = this.states.get(key);
			if (!current || current.kind !== "ready") {
				// Refuse to silently drift — callers rely on this bump to match
				// refCount to the number of downstream consumers.
				throw new ManagedRepoStoreError(
					"bump-invalid-state",
					`bumpRefCount requires a ready entry for ${key} (got ${current?.kind ?? "none"})`,
				);
			}
			current.refCount += by;
		});
	}

	async release(owner: string, repo: string): Promise<void> {
		const key = canonicalKey(owner, repo);

		// Step 1: decrement; if zero, transition to deleting with a pending promise
		const next = await this.lockFor(key).run(async () => {
			const current = this.states.get(key);
			if (!current || current.kind !== "ready") return { action: "noop" as const };
			current.refCount -= 1;
			if (current.refCount > 0) {
				return { action: "kept" as const };
			}
			let resolveDel!: () => void;
			let rejectDel!: (err: unknown) => void;
			const deletionPromise = new Promise<void>((res, rej) => {
				resolveDel = res;
				rejectDel = rej;
			});
			this.states.set(key, {
				kind: "deleting",
				promise: deletionPromise,
				owner,
				repo,
			});
			return {
				action: "delete" as const,
				path: current.path,
				resolveDel,
				rejectDel,
			};
		});

		if (next.action !== "delete") return;

		// Step 2: perform rm outside the lock
		let caught: unknown;
		try {
			await this.deps.rm(next.path);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code !== "ENOENT") caught = err;
		}
		if (!caught) {
			logger.info(`[managed-repo] action=delete owner=${owner} repo=${repo}`);
		}

		// Step 3: finalize under the lock
		await this.lockFor(key).run(async () => {
			this.states.delete(key);
		});

		if (caught) {
			next.rejectDel(caught);
			throw caught;
		}
		next.resolveDel();
	}

	async seedFromWorkflows(workflows: Workflow[]): Promise<void> {
		const counts = new Map<string, { owner: string; repo: string; count: number }>();
		for (const w of workflows) {
			if (!w.managedRepo) continue;
			if (isTerminalStatus(w.status)) continue;
			const key = canonicalKey(w.managedRepo.owner, w.managedRepo.repo);
			const entry = counts.get(key);
			if (entry) entry.count += 1;
			else counts.set(key, { owner: w.managedRepo.owner, repo: w.managedRepo.repo, count: 1 });
		}
		for (const [key, { owner, repo, count }] of counts) {
			const path = join(this.deps.baseDir, owner, repo);
			const exists = await this.deps.pathExists(path);
			if (!exists) {
				logger.warn(
					`[managed-repo] seed skipped — clone dir missing: ${path} (${count} workflows orphaned)`,
				);
				continue;
			}
			this.states.set(key, { kind: "ready", path, refCount: count, owner, repo });
		}
	}
}

function isTerminalStatus(status: Workflow["status"]): boolean {
	return status === "completed" || status === "cancelled" || status === "error";
}

/** Production default — spawns via gitSpawn and handles real fs. */
export function createDefaultManagedRepoStore(): ManagedRepoStore {
	const baseDir = join(homedir(), ".litus", "repos");
	return new ManagedRepoStore({
		baseDir,
		async runCmd(cmd, cwd) {
			try {
				const r = await gitSpawn(cmd, cwd ? { cwd } : undefined);
				return { ...r, missing: false };
			} catch (err) {
				const e = err as NodeJS.ErrnoException;
				if (e?.code === "ENOENT") {
					return { code: -1, stdout: "", stderr: "", missing: true };
				}
				throw err;
			}
		},
		async rm(p) {
			await fsRm(p, { recursive: true, force: true });
		},
		async pathExists(p) {
			try {
				const { stat } = await import("node:fs/promises");
				await stat(p);
				return true;
			} catch {
				return false;
			}
		},
	});
}
