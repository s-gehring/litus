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
		test("dispatches git fetch, git merge, and Claude CLI in order", async () => {
			const calls: string[][] = [];
			await resolveConflicts("/tmp/worktree", "feature summary", () => {}, {
				spawn: (args: string[]) => {
					calls.push(args);
					return {
						exited: Promise.resolve(0),
						stdout: new ReadableStream({
							start(c) {
								c.close();
							},
						}),
						stderr: new ReadableStream({
							start(c) {
								c.close();
							},
						}),
					};
				},
			});

			expect(calls.length).toBe(5);
			expect(calls[0]).toEqual(["git", "fetch", "origin", "master"]);
			expect(calls[1]).toEqual(["git", "merge", "origin/master"]);
			expect(calls[2][0]).toBe("claude");
			expect(calls[2]).toContain("-p");
			// Safety net: ensureCommittedAndPushed checks status then pushes
			expect(calls[3]).toEqual(["git", "status", "--porcelain"]);
			expect(calls[4]).toEqual(["git", "push"]);
		});

		test("amends merge-conflict commit when uncommitted changes remain", async () => {
			const calls: string[][] = [];
			let callIndex = 0;
			await resolveConflicts("/tmp/worktree", "feature summary", () => {}, {
				spawn: (args: string[]) => {
					calls.push(args);
					callIndex++;
					const idx = callIndex;
					return {
						exited: Promise.resolve(0),
						stdout: new ReadableStream({
							start(c) {
								// git status --porcelain returns dirty
								if (idx === 4) c.enqueue(new TextEncoder().encode(" M file.ts\n"));
								// git log returns merge-conflict commit message
								if (idx === 5)
									c.enqueue(
										new TextEncoder().encode("chore: resolve merge conflicts with master\n"),
									);
								c.close();
							},
						}),
						stderr: new ReadableStream({
							start(c) {
								c.close();
							},
						}),
					};
				},
			});

			// fetch, merge, claude, status, log, add, amend, push
			expect(calls.length).toBe(8);
			expect(calls[5]).toEqual(["git", "add", "."]);
			expect(calls[6]).toEqual(["git", "commit", "--amend", "--no-edit"]);
			expect(calls[7]).toEqual(["git", "push"]);
		});

		test("creates new commit when last commit is not merge-conflict commit", async () => {
			const calls: string[][] = [];
			let callIndex = 0;
			await resolveConflicts("/tmp/worktree", "feature summary", () => {}, {
				spawn: (args: string[]) => {
					calls.push(args);
					callIndex++;
					const idx = callIndex;
					return {
						exited: Promise.resolve(0),
						stdout: new ReadableStream({
							start(c) {
								if (idx === 4) c.enqueue(new TextEncoder().encode(" M file.ts\n"));
								if (idx === 5) c.enqueue(new TextEncoder().encode("feat: some other commit\n"));
								c.close();
							},
						}),
						stderr: new ReadableStream({
							start(c) {
								c.close();
							},
						}),
					};
				},
			});

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
			let callCount = 0;
			const promise = resolveConflicts("/tmp/worktree", "feature summary", () => {}, {
				spawn: () => {
					callCount++;
					if (callCount <= 2) {
						return {
							exited: Promise.resolve(0),
							stdout: new ReadableStream({
								start(c) {
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
					// Claude CLI fails
					return {
						exited: Promise.resolve(1),
						stdout: new ReadableStream({
							start(c) {
								c.close();
							},
						}),
						stderr: new ReadableStream({
							start(c) {
								c.enqueue(new TextEncoder().encode("Claude error output"));
								c.close();
							},
						}),
					};
				},
			});

			expect(promise).rejects.toThrow("Conflict resolution failed");
		});
	});
});
