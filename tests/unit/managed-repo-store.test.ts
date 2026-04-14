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
					// Synthesize that the destPath now exists
					const destPath = cmd[cmd.length - 1];
					existing.add(destPath);
				}
				return r;
			}
			if (cmd[0] === "git" && cmd[1] === "fetch") {
				return opts.fetchBehavior ? await opts.fetchBehavior(cmd, cwd) : ok();
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

		const result = await store.acquire("sub-1", "https://github.com/Foo/Bar.git");

		expect(result.owner).toBe("Foo");
		expect(result.repo).toBe("Bar");
		expect(result.path).toBe(join("/root/.litus/repos", "Foo", "Bar"));
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

		const a = await store.acquire("s1", "https://github.com/Foo/Bar.git");
		const b = await store.acquire("s2", "git@github.com:foo/bar");

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
		const r = await store.acquire("s1", "https://github.com/Foo/Bar.git");

		expect(ghTried).toBe(true);
		expect(r.path).toContain("Foo");

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
		await store.acquire("s1", "https://github.com/Foo/Bar.git");

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
		await expect(store.acquire("s1", "https://github.com/Foo/Bar.git")).rejects.toThrow();

		// The failed entry is cleaned up so a retry could start fresh.
		expect(store.getStateForTest("foo/bar")).toBeUndefined();
	});

	test("rejects non-GitHub URL with non-github-url code", async () => {
		const { deps } = mockDeps();
		const store = new ManagedRepoStore(deps);
		let caught: unknown;
		try {
			await store.acquire("s1", "https://gitlab.com/foo/bar.git");
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
		await store.acquire("s1", "https://github.com/Foo/Bar.git", {
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

		const p1 = store.acquire("s1", "https://github.com/Foo/Bar.git");
		const p2 = store.acquire("s2", "git@github.com:foo/bar");

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

		await store.acquire("s1", "https://github.com/Foo/Bar.git");
		await store.acquire("s2", "https://github.com/Foo/Bar.git");

		const fetchCalls = calls.filter((c) => c.cmd[0] === "git" && c.cmd[1] === "fetch");
		expect(fetchCalls).toHaveLength(1);

		expect(store.getStateForTest("foo/bar")).toEqual({ kind: "ready", refCount: 2 });
	});
});

describe("ManagedRepoStore — US3 (release + seed)", () => {
	test("release on ready(1) transitions to deleting and removes the clone dir", async () => {
		const { deps, removed } = mockDeps();
		const store = new ManagedRepoStore(deps);

		const r = await store.acquire("s1", "https://github.com/Foo/Bar.git");
		await store.release("Foo", "Bar");

		expect(removed).toContain(r.path);
		expect(store.getStateForTest("foo/bar")).toBeUndefined();
	});

	test("release on ready(n>1) decrements and leaves the dir", async () => {
		const { deps, removed } = mockDeps();
		const store = new ManagedRepoStore(deps);

		await store.acquire("s1", "https://github.com/Foo/Bar.git");
		await store.acquire("s2", "https://github.com/Foo/Bar.git");
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
		await store.acquire("s1", "https://github.com/Foo/Bar.git");
		await expect(store.release("Foo", "Bar")).resolves.toBeUndefined();
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

		await store.acquire("s1", "https://github.com/Foo/Bar.git");
		const releasePromise = store.release("Foo", "Bar");
		// While deletion is in flight, start a new acquire for same repo
		const acquirePromise = store.acquire("s2", "https://github.com/Foo/Bar.git");
		await Promise.resolve();
		resolveDelete();
		await releasePromise;
		const r = await acquirePromise;

		const cloneCalls = calls.filter(
			(c) => c.cmd[0] === "gh" || (c.cmd[0] === "git" && c.cmd[1] === "clone"),
		);
		// One clone for the first acquire, a second clone after the delete
		expect(cloneCalls.length).toBe(2);
		expect(r.path).toContain("Foo");
	});

	test("seedFromWorkflows seeds ready(refCount=N) for non-terminal workflows whose clone dir exists", async () => {
		const baseDir = "/root/.litus/repos";
		const existing = new Set<string>([join(baseDir, "Foo", "Bar")]);
		const { deps } = mockDeps({ baseDir, existing });
		const store = new ManagedRepoStore(deps);

		// 2 non-terminal + 1 terminal for Foo/Bar; 1 non-terminal for Missing/One (dir missing)
		await store.seedFromWorkflows([
			{
				managedRepo: { owner: "Foo", repo: "Bar" },
				status: "running",
			} as never,
			{
				managedRepo: { owner: "Foo", repo: "Bar" },
				status: "paused",
			} as never,
			{
				managedRepo: { owner: "Foo", repo: "Bar" },
				status: "completed",
			} as never,
			{
				managedRepo: null,
				status: "running",
			} as never,
			{
				managedRepo: { owner: "Missing", repo: "One" },
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
		await store.acquire("s1", "https://github.com/Foo/Bar.git");
		await store.bumpRefCount("Foo", "Bar", 2);
		expect(store.getStateForTest("foo/bar")).toEqual({ kind: "ready", refCount: 3 });
	});

	test("no-op when by <= 0", async () => {
		const { deps } = mockDeps();
		const store = new ManagedRepoStore(deps);
		await store.acquire("s1", "https://github.com/Foo/Bar.git");
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
		await store.acquire("s1", "https://github.com/Foo/Bar.git");
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
		await store.acquire("s1", "https://github.com/Foo/Bar.git");
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
		await store.acquire("s1", "https://github.com/Foo/Bar.git");
		const events: Array<{ step?: string; reused?: boolean }> = [];
		await store.acquire("s2", "https://github.com/Foo/Bar.git", {
			onStart: (_o, _r, reused) => events.push({ reused }),
			onProgress: (step) => events.push({ step }),
		});
		expect(events[0]).toEqual({ reused: true });
		const steps = events.filter((e) => e.step).map((e) => e.step);
		expect(steps).toEqual(["fetching", "ready"]);
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

		const p1 = store.acquire("s1", "https://github.com/Foo/Bar.git");
		const events: Array<{ step?: string; reused?: boolean }> = [];
		const p2 = store.acquire("s2", "https://github.com/Foo/Bar.git", {
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
