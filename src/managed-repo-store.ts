import { rm as fsRm, stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
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

	async acquire(rawUrl: string, callbacks?: AcquireCallbacks): Promise<AcquireResult> {
		const parsed = parseGitHubUrl(rawUrl);
		if (!parsed) {
			throw new ManagedRepoStoreError(
				"non-github-url",
				"Only GitHub URLs are supported — use a local folder path for other hosts.",
			);
		}
		// Canonicalise owner/repo to lowercase so the state key, the on-disk
		// destPath, and the owner/repo written onto the workflow record all
		// agree on casing. Without this, a second submission of the same repo
		// in different case (e.g. "Foo/Bar" then "foo/bar") shares the state
		// entry via canonicalKey but writes a differently-cased `managedRepo`
		// onto its workflow; on Linux (case-sensitive FS), `seedFromWorkflows`
		// would then fail to find the clone at <baseDir>/foo/bar because the
		// actual dir is <baseDir>/Foo/Bar. Lowercasing here matches GitHub's
		// own canonical behaviour (github.com/Foo/Bar ↔ github.com/foo/bar).
		const owner = parsed.owner.toLowerCase();
		const repo = parsed.repo.toLowerCase();
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
				// Do not emit "resolving" here — the retry iteration emits it on the
				// owner branch, and two coarse "resolving" steps with no intervening
				// transition confuses the client's progress rendering.
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
						callbacks?.onProgress?.("fetching", "warning: git fetch failed; using cached refs");
					} else {
						logger.info(`[managed-repo] action=fetch owner=${owner} repo=${repo}`);
					}
				} catch (err) {
					logger.warn(`[managed-repo] git fetch errored for ${key}: ${err}`);
					callbacks?.onProgress?.("fetching", "warning: git fetch failed; using cached refs");
				}
				callbacks?.onProgress?.("ready");
				return { owner, repo, path: decision.path, reused: true };
			}

			// Owner role: perform the clone outside the lock
			callbacks?.onStart?.(owner, repo, false);
			callbacks?.onProgress?.("resolving");
			try {
				// Salvage a pre-existing matching clone at destPath — covers crashes
				// mid-release (dir survived but state was wiped), seedFromWorkflows
				// skipping an all-terminal repo, and release failures where the
				// state was cleaned up but the dir was not. Without this probe,
				// performClone fails opaquely ("destination not empty") on any of
				// those paths.
				const salvaged =
					(await this.deps.pathExists(destPath)) &&
					(await this.trySalvageExistingClone(owner, repo, destPath));
				let fallbackUsed: "git" | undefined;
				if (salvaged) {
					logger.info(`[managed-repo] action=salvage owner=${owner} repo=${repo}`);
				} else {
					// If destPath exists but isn't a valid matching clone, remove it so
					// `git`/`gh clone` won't fail with "destination not empty".
					if (await this.deps.pathExists(destPath)) {
						await this.deps.rm(destPath);
					}
					callbacks?.onProgress?.("cloning");
					const cloneRes = await this.performClone(owner, repo, rawUrl, destPath);
					fallbackUsed = cloneRes.fallbackUsed;
					logger.info(
						`[managed-repo] action=clone owner=${owner} repo=${repo}${fallbackUsed ? ` fallbackUsed=${fallbackUsed}` : ""}`,
					);
				}
				// Transition cloning → ready under lock; final refCount is `waiters`.
				const finalPath = await this.lockFor(key).run(async () => {
					const current = this.states.get(key);
					// The per-key lock guarantees no other transition happens between
					// installing `cloning` (acquire owner branch) and this block.
					// Hitting any other state is a state-machine bug, not a race.
					if (!current || current.kind !== "cloning") {
						throw new ManagedRepoStoreError(
							"state-invariant",
							`expected cloning state for ${key}, found ${current?.kind ?? "none"}`,
						);
					}
					this.states.set(key, {
						kind: "ready",
						path: destPath,
						refCount: current.waiters,
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
					if (current?.kind === "cloning") {
						// Safe to delete the lock entry from inside its own run: this
						// callback finishes before any new lockFor(key) observes the
						// absent entry and creates a fresh lock.
						this.states.delete(key);
						this.locks.delete(key);
					}
				});
				decision.rejectClone(err);
				throw err;
			}
		}
	}

	/**
	 * Probe whether `destPath` is a valid git repo whose `origin` points at the
	 * expected GitHub `<owner>/<repo>`. Returns `true` on a match, `false` on any
	 * mismatch, probe failure, or non-git directory (caller then wipes and
	 * re-clones).
	 */
	private async trySalvageExistingClone(
		owner: string,
		repo: string,
		destPath: string,
	): Promise<boolean> {
		const revParse = await this.deps.runCmd(["git", "rev-parse", "--git-dir"], destPath);
		if (revParse.code !== 0) return false;
		const remote = await this.deps.runCmd(["git", "remote", "get-url", "origin"], destPath);
		if (remote.code !== 0) return false;
		const url = remote.stdout.trim();
		const parsed = parseGitHubUrl(url);
		if (!parsed) return false;
		return canonicalKey(parsed.owner, parsed.repo) === canonicalKey(owner, repo);
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
		// Match gh-specific auth phrasing only. The previous "authentication"
		// substring was too broad — it matched proxy errors, generic git helper
		// messages, and self-hosted gh variants, causing us to silently fall
		// back to `git clone` on genuine clone failures and hide the real error.
		const isAuthError = /not logged in|gh auth login|you must authenticate/i.test(ghResult.stderr);

		if (!isGhMissing && !isAuthError) {
			throw new ManagedRepoStoreError(
				"clone-failed",
				ghResult.stderr || `gh repo clone failed (exit ${ghResult.code})`,
			);
		}

		// Fall back to raw git clone with the user-supplied URL
		const gitResult = await this.deps.runCmd(["git", "clone", "--quiet", rawUrl, destPath]);
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

	/**
	 * If `path` points at a currently-ready managed clone's folder, bump its
	 * refCount by 1 and return its owner/repo so the caller can attach it to
	 * the workflow record. Returns null otherwise.
	 *
	 * Used by the workflow-start flow when a path input (e.g. the client's
	 * "last target repo" prefill) resolves to a folder that is actually a
	 * managed clone — without this, the second workflow would not participate
	 * in refcounting and releasing the first workflow would delete the folder
	 * out from under the second one.
	 */
	async tryAttachByPath(path: string): Promise<{ owner: string; repo: string } | null> {
		// Extract <owner>/<repo> from <baseDir>/<owner>/<repo>. Any other shape
		// (unrelated path, nested deeper, outside baseDir) → not a managed clone.
		const rel = relative(this.deps.baseDir, path);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
		const parts = rel.split(/[\\/]/).filter(Boolean);
		if (parts.length !== 2) return null;
		const [owner, repo] = parts;
		const key = canonicalKey(owner, repo);
		return this.lockFor(key).run(async () => {
			const current = this.states.get(key);
			// Attach only to a ready entry. "cloning" means the canonical acquire
			// flow owns lifecycle already; "deleting" means the folder is on its
			// way out and must not gain new holders.
			if (!current || current.kind !== "ready") return null;
			if (current.path !== path) return null;
			current.refCount += 1;
			return { owner: current.owner, repo: current.repo };
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
			// Prevent unhandled-rejection noise when no acquire is awaiting this
			// promise (the failed-delete path is currently the only producer).
			deletionPromise.catch(() => undefined);
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

		// Step 3: finalize under the lock. On failure (EBUSY/EACCES/EPERM) the
		// on-disk clone dir still exists, so we restore a `ready` entry rather
		// than dropping the state: a fresh `acquire` can then reuse the clone
		// instead of trying to clone into a populated directory, and a future
		// `release` can retry the delete.
		await this.lockFor(key).run(async () => {
			if (caught) {
				this.states.set(key, {
					kind: "ready",
					path: next.path,
					refCount: 1,
					owner,
					repo,
				});
			} else {
				// Safe to delete the lock entry from inside its own run: this
				// callback finishes before any new lockFor(key) observes the
				// absent entry and creates a fresh lock.
				this.states.delete(key);
				this.locks.delete(key);
			}
		});

		if (caught) {
			logger.warn(
				`[managed-repo] delete failed for ${owner}/${repo}; state restored to ready: ${caught}`,
			);
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

/**
 * Statuses that mean a workflow will never touch its clone again. `error` is
 * intentionally NOT terminal here: an errored workflow can be retried from the
 * UI, and the retry re-enters the spawn path at the same worktree — releasing
 * (and potentially deleting) the clone before retry turns every retry into a
 * missing-cwd error. Only `completed` and `cancelled` are true one-way exits.
 */
function isTerminalStatus(status: Workflow["status"]): boolean {
	return status === "completed" || status === "cancelled";
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
				await fsStat(p);
				return true;
			} catch {
				return false;
			}
		},
	});
}
