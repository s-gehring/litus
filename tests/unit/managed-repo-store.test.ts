import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	ManagedRepoStore,
	type RepoStoreDeps,
	type RunCmdResult,
} from "../../src/managed-repo-store";

function ok(stdout = ""): RunCmdResult {
	return { code: 0, stdout, stderr: "", missing: false };
}

function fail(stderr: string, code = 128): RunCmdResult {
	return { code, stdout: "", stderr, missing: false };
}

function missing(): RunCmdResult {
	return { code: -1, stdout: "", stderr: "", missing: true };
}

interface MockDepsOptions {
	baseDir?: string;
	cloneBehavior?: (cmd: string[], cwd?: string) => RunCmdResult | Promise<RunCmdResult>;
	fetchBehavior?: (cmd: string[], cwd?: string) => RunCmdResult | Promise<RunCmdResult>;
	existing?: Set<string>;
	/** If set, `git remote get-url origin` returns this URL for any cwd. */
	salvageRemoteUrl?: string;
	/** If true, `git rev-parse --git-dir` returns code 1 (not a git dir). */
	salvageRevParseFails?: boolean;
}

function mockDeps(opts: MockDepsOptions = {}): {
	deps: RepoStoreDeps;
	calls: { cmd: string[]; cwd?: string }[];
	removed: string[];
} {
	const calls: { cmd: string[]; cwd?: string }[] = [];
	const removed: string[] = [];
	const existing = opts.existing ?? new Set<string>();
	const deps: RepoStoreDeps = {
		baseDir: opts.baseDir ?? "/home/test/.litus/repos",
		runCmd: async (cmd, cwd) => {
			calls.push({ cmd, cwd });
			if (cmd[0] === "gh" || (cmd[0] === "git" && cmd[1] === "clone")) {
				const r = opts.cloneBehavior ? await opts.cloneBehavior(cmd, cwd) : ok();
				if (r.code === 0) {
					// Synthesize that the destPath now exists. The destPath is
					// positional index 4 for both forms:
					//   `gh repo clone <owner/repo> <dest> -- --quiet`
					//   `git clone --quiet <url> <dest>`
					const destPath = cmd[4];
					if (destPath) existing.add(destPath);
				}
				return r;
			}
			if (cmd[0] === "git" && cmd[1] === "fetch") {
				return opts.fetchBehavior ? await opts.fetchBehavior(cmd, cwd) : ok();
			}
			if (cmd[0] === "git" && cmd[1] === "rev-parse" && cmd[2] === "--git-dir") {
				return opts.salvageRevParseFails ? fail("not a git repository", 128) : ok(".git");
			}
			if (cmd[0] === "git" && cmd[1] === "remote" && cmd[2] === "get-url") {
				return opts.salvageRemoteUrl ? ok(opts.salvageRemoteUrl) : fail("no origin", 2);
			}
			return ok();
		},
		rm: async (p) => {
			removed.push(p);
			existing.delete(p);
		},
		pathExists: async (p) => existing.has(p),
	};
	return { deps, calls, removed };
}

describe("ManagedRepoStore — fresh clone (US1)", () => {
	test("undefined → cloning → ready(1); returns path under baseDir", async () => {
		const { deps, calls } = mockDeps({ baseDir: "/root/.litus/repos" });
		const store = new ManagedRepoStore(deps);

		const result = await store.acquire("https://github.com/Foo/Bar.git");

		// Owner/repo are canonicalised to lowercase so the on-disk destPath,
		// state-map key, and workflow record all agree regardless of URL case.
		expect(result.owner).toBe("foo");
		expect(result.repo).toBe("bar");
		expect(result.path).toBe(join("/root/.litus/repos", "foo", "bar"));
		expect(result.reused).toBe(false);

		// gh was tried (exactly one clone invocation for the single successful clone)
		const cloneCalls = calls.filter(
			(c) => c.cmd[0] === "gh" || (c.cmd[0] === "git" && c.cmd[1] === "clone"),
		);
		expect(cloneCalls).toHaveLength(1);
		expect(cloneCalls[0].cmd[0]).toBe("gh");

		expect(store.getStateForTest("foo/bar")).toEqual({ kind: "ready", refCount: 1 });
	});

	test("canonical key dedupe: HTTPS + SSH forms of the same repo share an entry", async () => {
		const { deps, calls } = mockDeps();
		const store = new ManagedRepoStore(deps);

		const a = await store.acquire("https://github.com/Foo/Bar.git");
		const b = await store.acquire("git@github.com:foo/bar");

		expect(a.path).toBe(b.path);
		// Only one clone (the second is a ready-reuse)
		const cloneCalls = calls.filter(
			(c) => c.cmd[0] === "gh" || (c.cmd[0] === "git" && c.cmd[1] === "clone"),
		);
		expect(cloneCalls).toHaveLength(1);
	});

	test("gh missing (ENOENT) falls back to raw git clone", async () => {
		let ghTried = false;
		const { deps, calls } = mockDeps({
			cloneBehavior: (cmd) => {
				if (cmd[0] === "gh") {
					ghTried = true;
					return missing();
				}
				return ok();
			},
		});
		const store = new ManagedRepoStore(deps);
		const r = await store.acquire("https://github.com/Foo/Bar.git");

		expect(ghTried).toBe(true);
		expect(r.path).toContain("foo");

		const cloneCalls = calls.filter(
			(c) => c.cmd[0] === "gh" || (c.cmd[0] === "git" && c.cmd[1] === "clone"),
		);
		expect(cloneCalls).toHaveLength(2);
		expect(cloneCalls[0].cmd[0]).toBe("gh");
		expect(cloneCalls[1].cmd.slice(0, 2)).toEqual(["git", "clone"]);
		// git clone uses the raw user-supplied URL
		expect(cloneCalls[1].cmd).toContain("https://github.com/Foo/Bar.git");
	});

	test("gh auth error falls back to raw git clone", async () => {
		const { deps, calls } = mockDeps({
			cloneBehavior: (cmd) => {
				if (cmd[0] === "gh") {
					return fail("error: you are not logged in. Run: gh auth login", 1);
				}
				return ok();
			},
		});
		const store = new ManagedRepoStore(deps);
		await store.acquire("https://github.com/Foo/Bar.git");

		const cloneCalls = calls.filter(
			(c) => c.cmd[0] === "gh" || (c.cmd[0] === "git" && c.cmd[1] === "clone"),
		);
		expect(cloneCalls).toHaveLength(2);
		expect(cloneCalls[1].cmd.slice(0, 2)).toEqual(["git", "clone"]);
	});

	test("gh non-auth failure does NOT fall back to git clone; error bubbles", async () => {
		const { deps } = mockDeps({
			cloneBehavior: () => fail("fatal: could not find repository", 1),
		});
		const store = new ManagedRepoStore(deps);
		await expect(store.acquire("https://github.com/Foo/Bar.git")).rejects.toThrow();

		// The failed entry is cleaned up so a retry could start fresh.
		expect(store.getStateForTest("foo/bar")).toBeUndefined();
	});

	test("rejects non-GitHub URL with non-github-url code", async () => {
		const { deps } = mockDeps();
		const store = new ManagedRepoStore(deps);
		let caught: unknown;
		try {
			await store.acquire("https://gitlab.com/foo/bar.git");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		expect((caught as { code?: string }).code).toBe("non-github-url");
	});

	test("emits resolving → cloning → ready progress events", async () => {
		const { deps } = mockDeps();
		const store = new ManagedRepoStore(deps);
		const events: Array<{ kind: string; step?: string; reused?: boolean }> = [];
		await store.acquire("https://github.com/Foo/Bar.git", {
			onStart: (_o, _r, reused) => events.push({ kind: "start", reused }),
			onProgress: (step) => events.push({ kind: "progress", step }),
		});
		expect(events[0]).toEqual({ kind: "start", reused: false });
		const steps = events.filter((e) => e.kind === "progress").map((e) => e.step);
		expect(steps).toEqual(["resolving", "cloning", "ready"]);
	});
});

describe("ManagedRepoStore — US2 (coalescing + ready reuse)", () => {
	test("concurrent acquire during cloning coalesces into one subprocess", async () => {
		// Gate the first clone subprocess so the second acquire lands during cloning
		let resolveClone!: () => void;
		const gate = new Promise<void>((r) => {
			resolveClone = r;
		});
		let cloneCount = 0;
		const { deps, calls } = mockDeps({
			cloneBehavior: async () => {
				cloneCount++;
				await gate;
				return ok();
			},
		});
		const store = new ManagedRepoStore(deps);

		const p1 = store.acquire("https://github.com/Foo/Bar.git");
		const p2 = store.acquire("git@github.com:foo/bar");

		// Let both queue
		await Promise.resolve();
		resolveClone();
		const [r1, r2] = await Promise.all([p1, p2]);

		expect(r1.path).toBe(r2.path);
		expect(cloneCount).toBe(1);
		const cloneCalls = calls.filter(
			(c) => c.cmd[0] === "gh" || (c.cmd[0] === "git" && c.cmd[1] === "clone"),
		);
		expect(cloneCalls).toHaveLength(1);
		// Waiter is marked reused
		expect(r1.reused === false && r2.reused === true).toBe(true);

		const state = store.getStateForTest("foo/bar");
		expect(state).toEqual({ kind: "ready", refCount: 2 });
	});

	test("acquire against ready entry runs git fetch exactly once and increments refCount", async () => {
		const { deps, calls } = mockDeps();
		const store = new ManagedRepoStore(deps);

		await store.acquire("https://github.com/Foo/Bar.git");
		await store.acquire("https://github.com/Foo/Bar.git");

		const fetchCalls = calls.filter((c) => c.cmd[0] === "git" && c.cmd[1] === "fetch");
		expect(fetchCalls).toHaveLength(1);

		expect(store.getStateForTest("foo/bar")).toEqual({ kind: "ready", refCount: 2 });
	});
});

describe("ManagedRepoStore — US3 (release + seed)", () => {
	test("release on ready(1) transitions to deleting and removes the clone dir", async () => {
		const { deps, removed } = mockDeps();
		const store = new ManagedRepoStore(deps);

		const r = await store.acquire("https://github.com/Foo/Bar.git");
		await store.release("Foo", "Bar");

		expect(removed).toContain(r.path);
		expect(store.getStateForTest("foo/bar")).toBeUndefined();
	});

	test("release on ready(n>1) decrements and leaves the dir", async () => {
		const { deps, removed } = mockDeps();
		const store = new ManagedRepoStore(deps);

		await store.acquire("https://github.com/Foo/Bar.git");
		await store.acquire("https://github.com/Foo/Bar.git");
		await store.release("Foo", "Bar");

		expect(removed).toEqual([]);
		expect(store.getStateForTest("foo/bar")).toEqual({ kind: "ready", refCount: 1 });
	});

	test("release is a no-op on an unknown key", async () => {
		const { deps, removed } = mockDeps();
		const store = new ManagedRepoStore(deps);
		await store.release("Foo", "Bar");
		expect(removed).toEqual([]);
	});

	test("release swallows ENOENT when directory is already gone", async () => {
		const { deps } = mockDeps();
		// rm throws — simulate already-gone: the store's rm wrapper should swallow it.
		deps.rm = async () => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		};
		const store = new ManagedRepoStore(deps);
		await store.acquire("https://github.com/Foo/Bar.git");
		await expect(store.release("Foo", "Bar")).resolves.toBeUndefined();
		// Pin the cleanup behaviour: an ENOENT-swallowed release must drop the
		// state entry entirely (not restore ready(1) like the EBUSY path). A
		// future refactor that accidentally treats ENOENT like EBUSY would
		// leak the in-memory entry forever — the on-disk dir is truly gone, so
		// future acquires would re-clone, but the stale ready(1) refcount
		// would never drain.
		expect(store.getStateForTest("foo/bar")).toBeUndefined();
	});

	test("release on non-ENOENT rm failure re-installs ready state so a retry can delete", async () => {
		const { deps } = mockDeps();
		let attempts = 0;
		deps.rm = async () => {
			attempts += 1;
			if (attempts === 1) {
				const err = new Error("EBUSY") as NodeJS.ErrnoException;
				err.code = "EBUSY";
				throw err;
			}
			// Second attempt succeeds.
		};
		const store = new ManagedRepoStore(deps);
		await store.acquire("https://github.com/Foo/Bar.git");

		let firstErr: unknown;
		try {
			await store.release("Foo", "Bar");
		} catch (e) {
			firstErr = e;
		}
		expect((firstErr as NodeJS.ErrnoException | undefined)?.code).toBe("EBUSY");

		// State restored to ready(1) so a retry (or acquire+release) can finish the delete.
		expect(store.getStateForTest("foo/bar")).toEqual({ kind: "ready", refCount: 1 });

		await store.release("Foo", "Bar");
		expect(store.getStateForTest("foo/bar")).toBeUndefined();
		expect(attempts).toBe(2);
	});

	test("acquire after a failed release reuses the existing clone (no second clone)", async () => {
		const { deps, calls } = mockDeps();
		deps.rm = async () => {
			const err = new Error("EACCES") as NodeJS.ErrnoException;
			err.code = "EACCES";
			throw err;
		};
		const store = new ManagedRepoStore(deps);
		await store.acquire("https://github.com/Foo/Bar.git");
		let releaseErr: unknown;
		try {
			await store.release("Foo", "Bar");
		} catch (e) {
			releaseErr = e;
		}
		expect((releaseErr as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES");

		// Re-acquiring should treat the surviving clone as a reuse, not attempt a fresh clone
		// (which would fail because destPath already exists on disk).
		const result = await store.acquire("https://github.com/Foo/Bar.git");
		expect(result.reused).toBe(true);
		const cloneCalls = calls.filter(
			(c) => c.cmd[0] === "gh" || (c.cmd[0] === "git" && c.cmd[1] === "clone"),
		);
		expect(cloneCalls.length).toBe(1);
	});

	test("acquire during deleting waits, then starts a fresh clone (delete-wins)", async () => {
		let resolveDelete!: () => void;
		const deleteGate = new Promise<void>((r) => {
			resolveDelete = r;
		});
		const { deps, calls } = mockDeps();
		deps.rm = async () => {
			await deleteGate;
		};
		const store = new ManagedRepoStore(deps);

		await store.acquire("https://github.com/Foo/Bar.git");
		const releasePromise = store.release("Foo", "Bar");
		// While deletion is in flight, start a new acquire for same repo
		const acquirePromise = store.acquire("https://github.com/Foo/Bar.git");
		await Promise.resolve();
		resolveDelete();
		await releasePromise;
		const r = await acquirePromise;

		const cloneCalls = calls.filter(
			(c) => c.cmd[0] === "gh" || (c.cmd[0] === "git" && c.cmd[1] === "clone"),
		);
		// One clone for the first acquire, a second clone after the delete
		expect(cloneCalls.length).toBe(2);
		expect(r.path).toContain("foo");
	});

	test("seedFromWorkflows seeds ready(refCount=N) for non-terminal workflows whose clone dir exists", async () => {
		const baseDir = "/root/.litus/repos";
		// Acquire canonicalises owner/repo to lowercase, so on-disk dirs
		// created in production are lowercased; match that here.
		const existing = new Set<string>([join(baseDir, "foo", "bar")]);
		const { deps } = mockDeps({ baseDir, existing });
		const store = new ManagedRepoStore(deps);

		// 2 non-terminal + 1 terminal for foo/bar; 1 non-terminal for missing/one (dir missing)
		await store.seedFromWorkflows([
			{
				managedRepo: { owner: "foo", repo: "bar" },
				status: "running",
			} as never,
			{
				managedRepo: { owner: "foo", repo: "bar" },
				status: "paused",
			} as never,
			{
				managedRepo: { owner: "foo", repo: "bar" },
				status: "completed",
			} as never,
			{
				managedRepo: null,
				status: "running",
			} as never,
			{
				managedRepo: { owner: "missing", repo: "one" },
				status: "running",
			} as never,
		]);

		expect(store.getStateForTest("foo/bar")).toEqual({ kind: "ready", refCount: 2 });
		expect(store.getStateForTest("missing/one")).toBeUndefined();
	});
});

describe("ManagedRepoStore — bumpRefCount", () => {
	test("increments refCount on a ready entry", async () => {
		const { deps } = mockDeps();
		const store = new ManagedRepoStore(deps);
		await store.acquire("https://github.com/Foo/Bar.git");
		await store.bumpRefCount("Foo", "Bar", 2);
		expect(store.getStateForTest("foo/bar")).toEqual({ kind: "ready", refCount: 3 });
	});

	test("no-op when by <= 0", async () => {
		const { deps } = mockDeps();
		const store = new ManagedRepoStore(deps);
		await store.acquire("https://github.com/Foo/Bar.git");
		await store.bumpRefCount("Foo", "Bar", 0);
		await store.bumpRefCount("Foo", "Bar", -3);
		expect(store.getStateForTest("foo/bar")).toEqual({ kind: "ready", refCount: 1 });
	});

	test("throws with bump-invalid-state when entry is missing", async () => {
		const { deps } = mockDeps();
		const store = new ManagedRepoStore(deps);
		let caught: unknown;
		try {
			await store.bumpRefCount("Unknown", "Repo", 1);
		} catch (err) {
			caught = err;
		}
		expect((caught as { code?: string }).code).toBe("bump-invalid-state");
	});

	test("throws when entry is in a non-ready state (deleting)", async () => {
		let resolveDelete!: () => void;
		const deleteGate = new Promise<void>((r) => {
			resolveDelete = r;
		});
		const { deps } = mockDeps();
		deps.rm = async () => {
			await deleteGate;
		};
		const store = new ManagedRepoStore(deps);
		await store.acquire("https://github.com/Foo/Bar.git");
		const releasePromise = store.release("Foo", "Bar");
		// State is now "deleting" — bump must fail loudly.
		await expect(store.bumpRefCount("Foo", "Bar", 1)).rejects.toMatchObject({
			code: "bump-invalid-state",
		});
		resolveDelete();
		await releasePromise;
	});

	test("subsequent release(n) decrements the bumped count correctly", async () => {
		const { deps, removed } = mockDeps();
		const store = new ManagedRepoStore(deps);
		await store.acquire("https://github.com/Foo/Bar.git");
		await store.bumpRefCount("Foo", "Bar", 2); // refCount = 3
		await store.release("Foo", "Bar"); // refCount = 2
		expect(removed).toEqual([]);
		await store.release("Foo", "Bar"); // refCount = 1
		await store.release("Foo", "Bar"); // refCount = 0 -> delete
		expect(removed.length).toBe(1);
		expect(store.getStateForTest("foo/bar")).toBeUndefined();
	});
});

describe("ManagedRepoStore — progress event sequences", () => {
	test("ready-reuse emits fetching progress", async () => {
		const { deps } = mockDeps();
		const store = new ManagedRepoStore(deps);
		await store.acquire("https://github.com/Foo/Bar.git");
		const events: Array<{ step?: string; reused?: boolean }> = [];
		await store.acquire("https://github.com/Foo/Bar.git", {
			onStart: (_o, _r, reused) => events.push({ reused }),
			onProgress: (step) => events.push({ step }),
		});
		expect(events[0]).toEqual({ reused: true });
		const steps = events.filter((e) => e.step).map((e) => e.step);
		expect(steps).toEqual(["fetching", "ready"]);
	});

	test("salvage: pre-existing matching clone dir is adopted without cloning", async () => {
		const baseDir = "/root/.litus/repos";
		const destPath = join(baseDir, "foo", "bar");
		const existing = new Set<string>([destPath]);
		const { deps, calls } = mockDeps({
			baseDir,
			existing,
			salvageRemoteUrl: "https://github.com/Foo/Bar.git",
		});
		const store = new ManagedRepoStore(deps);

		const r = await store.acquire("https://github.com/Foo/Bar.git");

		expect(r.path).toBe(destPath);
		expect(r.reused).toBe(false);
		// No clone subprocess ran — salvage adopted the existing dir.
		const cloneCalls = calls.filter(
			(c) => c.cmd[0] === "gh" || (c.cmd[0] === "git" && c.cmd[1] === "clone"),
		);
		expect(cloneCalls).toHaveLength(0);
		// Refcount is still 1 (the initial acquire).
		expect(store.getStateForTest("foo/bar")).toEqual({ kind: "ready", refCount: 1 });
	});

	test("salvage: pre-existing dir whose origin mismatches is wiped and re-cloned", async () => {
		const baseDir = "/root/.litus/repos";
		const destPath = join(baseDir, "foo", "bar");
		const existing = new Set<string>([destPath]);
		const { deps, calls, removed } = mockDeps({
			baseDir,
			existing,
			salvageRemoteUrl: "https://github.com/Other/Repo.git",
		});
		const store = new ManagedRepoStore(deps);

		await store.acquire("https://github.com/Foo/Bar.git");

		expect(removed).toContain(destPath);
		// A full clone happened because salvage probe returned false.
		const cloneCalls = calls.filter(
			(c) => c.cmd[0] === "gh" || (c.cmd[0] === "git" && c.cmd[1] === "clone"),
		);
		expect(cloneCalls).toHaveLength(1);
	});

	test("salvage: pre-existing non-git dir is wiped and re-cloned", async () => {
		const baseDir = "/root/.litus/repos";
		const destPath = join(baseDir, "foo", "bar");
		const existing = new Set<string>([destPath]);
		const { deps, calls, removed } = mockDeps({
			baseDir,
			existing,
			salvageRevParseFails: true,
		});
		const store = new ManagedRepoStore(deps);

		await store.acquire("https://github.com/Foo/Bar.git");

		expect(removed).toContain(destPath);
		const cloneCalls = calls.filter(
			(c) => c.cmd[0] === "gh" || (c.cmd[0] === "git" && c.cmd[1] === "clone"),
		);
		expect(cloneCalls).toHaveLength(1);
	});

	test("waiter on in-flight clone emits waiter sequence and reused=true", async () => {
		let resolveClone!: () => void;
		const gate = new Promise<void>((r) => {
			resolveClone = r;
		});
		const { deps } = mockDeps({
			cloneBehavior: async () => {
				await gate;
				return ok();
			},
		});
		const store = new ManagedRepoStore(deps);

		const p1 = store.acquire("https://github.com/Foo/Bar.git");
		const events: Array<{ step?: string; reused?: boolean }> = [];
		const p2 = store.acquire("https://github.com/Foo/Bar.git", {
			onStart: (_o, _r, reused) => events.push({ reused }),
			onProgress: (step) => events.push({ step }),
		});

		await Promise.resolve();
		resolveClone();
		await Promise.all([p1, p2]);

		expect(events[0]).toEqual({ reused: true });
		const steps = events.filter((e) => e.step).map((e) => e.step);
		// Waiter path: resolving (waiting) → cloning → ready
		expect(steps).toEqual(["resolving", "cloning", "ready"]);
	});
});
