import { describe, expect, test } from "bun:test";
import { extractPrNumber, extractRepoFromUrl, mergePr, resolveConflicts } from "../src/pr-merger";

describe("pr-merger", () => {
	// T008: successful squash-merge returns { merged: true }
	describe("mergePr", () => {
		test("successful squash-merge returns merged: true", async () => {
			const result = await mergePr(
				"https://github.com/test/repo/pull/42",
				"/tmp/worktree",
				() => {},
				{
					spawn: () => ({
						exited: Promise.resolve(0),
						stdout: new ReadableStream({
							start(c) {
								c.enqueue(new TextEncoder().encode('{"state":"OPEN"}'));
								c.close();
							},
						}),
						stderr: new ReadableStream({
							start(c) {
								c.close();
							},
						}),
					}),
				},
			);

			expect(result.merged).toBe(true);
			expect(result.alreadyMerged).toBe(false);
			expect(result.conflict).toBe(false);
			expect(result.error).toBeNull();
		});

		// T009: already-merged PR detected via gh pr view --json state
		test("already-merged PR returns alreadyMerged: true", async () => {
			const result = await mergePr(
				"https://github.com/test/repo/pull/42",
				"/tmp/worktree",
				() => {},
				{
					spawn: () => ({
						exited: Promise.resolve(0),
						stdout: new ReadableStream({
							start(c) {
								c.enqueue(new TextEncoder().encode('{"state":"MERGED"}'));
								c.close();
							},
						}),
						stderr: new ReadableStream({
							start(c) {
								c.close();
							},
						}),
					}),
				},
			);

			expect(result.merged).toBe(false);
			expect(result.alreadyMerged).toBe(true);
			expect(result.conflict).toBe(false);
			expect(result.error).toBeNull();
		});

		// T015: conflict detected from gh pr merge stderr returns { conflict: true }
		test("conflict error returns conflict: true", async () => {
			let callCount = 0;
			const result = await mergePr(
				"https://github.com/test/repo/pull/42",
				"/tmp/worktree",
				() => {},
				{
					spawn: () => {
						callCount++;
						if (callCount === 1) {
							return {
								exited: Promise.resolve(0),
								stdout: new ReadableStream({
									start(c) {
										c.enqueue(new TextEncoder().encode('{"state":"OPEN"}'));
										c.close();
									},
								}),
								stderr: new ReadableStream({
									start(c) {
										c.close();
									},
								}),
							};
						}
						return {
							exited: Promise.resolve(1),
							stdout: new ReadableStream({
								start(c) {
									c.close();
								},
							}),
							stderr: new ReadableStream({
								start(c) {
									c.enqueue(
										new TextEncoder().encode("merge conflict: pull request is not mergeable"),
									);
									c.close();
								},
							}),
						};
					},
				},
			);

			expect(result.merged).toBe(false);
			expect(result.alreadyMerged).toBe(false);
			expect(result.conflict).toBe(true);
			expect(result.error).toBeNull();
		});

		// T010: non-conflict error (permissions/protection) returns { error: string }
		test("non-conflict error returns error string", async () => {
			let callCount = 0;
			const result = await mergePr(
				"https://github.com/test/repo/pull/42",
				"/tmp/worktree",
				() => {},
				{
					spawn: () => {
						callCount++;
						if (callCount === 1) {
							return {
								exited: Promise.resolve(0),
								stdout: new ReadableStream({
									start(c) {
										c.enqueue(new TextEncoder().encode('{"state":"OPEN"}'));
										c.close();
									},
								}),
								stderr: new ReadableStream({
									start(c) {
										c.close();
									},
								}),
							};
						}
						return {
							exited: Promise.resolve(1),
							stdout: new ReadableStream({
								start(c) {
									c.close();
								},
							}),
							stderr: new ReadableStream({
								start(c) {
									c.enqueue(
										new TextEncoder().encode("GraphQL: Branch protection rule prevents merge"),
									);
									c.close();
								},
							}),
						};
					},
				},
			);

			expect(result.merged).toBe(false);
			expect(result.conflict).toBe(false);
			expect(result.error).toContain("Branch protection rule");
		});
	});

	describe("extractPrNumber", () => {
		test("extracts PR number from URL", () => {
			expect(extractPrNumber("https://github.com/owner/repo/pull/123")).toBe("123");
		});

		test("returns null for invalid URL", () => {
			expect(extractPrNumber("not-a-url")).toBeNull();
		});
	});

	describe("extractRepoFromUrl", () => {
		test("extracts owner/repo from PR URL", () => {
			expect(extractRepoFromUrl("https://github.com/owner/repo/pull/123")).toBe("owner/repo");
		});

		test("returns null for invalid URL", () => {
			expect(extractRepoFromUrl("not-a-url")).toBeNull();
		});
	});

	// T016: resolveConflicts dispatches git fetch + git merge origin/master then Claude CLI
	describe("resolveConflicts", () => {
		// Helper: build a spawn stub that emits canned stdout/stderr per call index,
		// defaulting to exit 0 with empty streams. Call indices are 1-based to match
		// how the tests below describe the ordering (fetch=1, merge=2, ...).
		function makeSpawn(perCall: {
			[idx: number]: {
				exit?: number;
				stdout?: string;
				stderr?: string;
			};
		}) {
			const calls: string[][] = [];
			let callIndex = 0;
			const spawn = (args: string[]) => {
				calls.push(args);
				callIndex++;
				const canned = perCall[callIndex] ?? {};
				return {
					exited: Promise.resolve(canned.exit ?? 0),
					stdout: new ReadableStream({
						start(c) {
							if (canned.stdout) c.enqueue(new TextEncoder().encode(canned.stdout));
							c.close();
						},
					}),
					stderr: new ReadableStream({
						start(c) {
							if (canned.stderr) c.enqueue(new TextEncoder().encode(canned.stderr));
							c.close();
						},
					}),
				};
			};
			return { calls, spawn };
		}

		test("dispatches git fetch, git merge, and Claude CLI in order when merge reports conflicts", async () => {
			// Merge (call 2) exits non-zero and writes a CONFLICT marker → Claude path.
			const { calls, spawn } = makeSpawn({
				2: {
					exit: 1,
					stdout: "Auto-merging file.ts\nCONFLICT (content): Merge conflict in file.ts\n",
					stderr: "",
				},
			});
			const result = await resolveConflicts("/tmp/worktree", "feature summary", () => {}, {
				spawn,
			});

			expect(result.kind).toBe("resolved");
			expect(calls.length).toBe(5);
			expect(calls[0]).toEqual(["git", "fetch", "origin", "master"]);
			expect(calls[1]).toEqual(["git", "merge", "origin/master"]);
			expect(calls[2][0]).toBe("claude");
			expect(calls[2]).toContain("-p");
			// Safety net: ensureCommittedAndPushed checks status then pushes
			expect(calls[3]).toEqual(["git", "status", "--porcelain"]);
			expect(calls[4]).toEqual(["git", "push"]);
		});

		test("short-circuits to already-up-to-date when merge prints 'Already up to date.'", async () => {
			// Merge (call 2) exits 0 with the canonical "Already up to date." banner.
			const { calls, spawn } = makeSpawn({
				2: { exit: 0, stdout: "Already up to date.\n" },
			});
			const result = await resolveConflicts("/tmp/worktree", "feature summary", () => {}, {
				spawn,
			});

			expect(result.kind).toBe("already-up-to-date");
			// Claude must not be dispatched on this path.
			expect(calls.every((c) => c[0] !== "claude")).toBe(true);
			// Safety net still runs (status + push), even though it is a no-op.
			expect(calls).toEqual([
				["git", "fetch", "origin", "master"],
				["git", "merge", "origin/master"],
				["git", "status", "--porcelain"],
				["git", "push"],
			]);
		});

		test("short-circuits to clean-auto-merge when merge completes without conflict", async () => {
			// Merge (call 2) exits 0 with a typical merge-commit banner (no conflict).
			const { calls, spawn } = makeSpawn({
				2: { exit: 0, stdout: "Merge made by the 'ort' strategy.\n" },
			});
			const result = await resolveConflicts("/tmp/worktree", "feature summary", () => {}, {
				spawn,
			});

			expect(result.kind).toBe("clean-auto-merge");
			expect(calls.every((c) => c[0] !== "claude")).toBe(true);
			// Safety net runs, pushing the auto-merge commit.
			expect(calls).toEqual([
				["git", "fetch", "origin", "master"],
				["git", "merge", "origin/master"],
				["git", "status", "--porcelain"],
				["git", "push"],
			]);
		});

		test("throws when git merge fails for a reason other than a conflict", async () => {
			const { spawn } = makeSpawn({
				2: {
					exit: 128,
					stdout: "",
					stderr: "fatal: refusing to merge unrelated histories\n",
				},
			});
			const promise = resolveConflicts("/tmp/worktree", "feature summary", () => {}, {
				spawn,
			});
			expect(promise).rejects.toThrow("refusing to merge unrelated histories");
		});

		test("amends merge-conflict commit when uncommitted changes remain", async () => {
			const { calls, spawn } = makeSpawn({
				2: {
					exit: 1,
					stdout: "CONFLICT (content): Merge conflict in file.ts\n",
				},
				4: { stdout: " M file.ts\n" }, // git status --porcelain → dirty
				5: { stdout: "chore: resolve merge conflicts with master\n" }, // last log
			});
			await resolveConflicts("/tmp/worktree", "feature summary", () => {}, { spawn });

			// fetch, merge, claude, status, log, add, amend, push
			expect(calls.length).toBe(8);
			expect(calls[5]).toEqual(["git", "add", "."]);
			expect(calls[6]).toEqual(["git", "commit", "--amend", "--no-edit"]);
			expect(calls[7]).toEqual(["git", "push"]);
		});

		test("creates new commit when last commit is not merge-conflict commit", async () => {
			const { calls, spawn } = makeSpawn({
				2: {
					exit: 1,
					stdout: "CONFLICT (content): Merge conflict in file.ts\n",
				},
				4: { stdout: " M file.ts\n" },
				5: { stdout: "feat: some other commit\n" },
			});
			await resolveConflicts("/tmp/worktree", "feature summary", () => {}, { spawn });

			// fetch, merge, claude, status, log, add, commit, push
			expect(calls.length).toBe(8);
			expect(calls[5]).toEqual(["git", "add", "."]);
			expect(calls[6]).toEqual([
				"git",
				"commit",
				"-m",
				"chore: resolve merge conflicts with master",
			]);
			expect(calls[7]).toEqual(["git", "push"]);
		});

		test("throws when Claude CLI exits with non-zero code", async () => {
			const { spawn } = makeSpawn({
				2: { exit: 1, stdout: "CONFLICT (content): Merge conflict in file.ts\n" },
				3: { exit: 1, stderr: "Claude error output" },
			});
			const promise = resolveConflicts("/tmp/worktree", "feature summary", () => {}, {
				spawn,
			});
			expect(promise).rejects.toThrow("Conflict resolution failed");
		});
	});
});
