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
			// Call 3 is the pre-Claude HEAD snapshot; call 7 is the post-safety-net
			// HEAD snapshot. They must differ so the no-new-commits guard passes.
			const { calls, spawn } = makeSpawn({
				2: {
					exit: 1,
					stdout: "Auto-merging file.ts\nCONFLICT (content): Merge conflict in file.ts\n",
					stderr: "",
				},
				3: { stdout: "aaaaaaa0000000000000000000000000000000000\n" },
				7: { stdout: "bbbbbbb0000000000000000000000000000000000\n" },
			});
			const result = await resolveConflicts("/tmp/worktree", "feature summary", () => {}, {
				spawn,
			});

			expect(result.kind).toBe("resolved");
			expect(calls.length).toBe(7);
			expect(calls[0]).toEqual(["git", "fetch", "origin", "master"]);
			expect(calls[1]).toEqual(["git", "merge", "origin/master"]);
			expect(calls[2]).toEqual(["git", "rev-parse", "HEAD"]);
			expect(calls[3][0]).toBe("claude");
			expect(calls[3]).toContain("-p");
			// Safety net: ensureCommittedAndPushed checks status then pushes
			expect(calls[4]).toEqual(["git", "status", "--porcelain"]);
			expect(calls[5]).toEqual(["git", "push"]);
			expect(calls[6]).toEqual(["git", "rev-parse", "HEAD"]);
		});

		test("forwards Claude stream-json assistant text through onOutput", async () => {
			// The Claude process (call 4) emits two stream-json events: one assistant
			// text block and one content_block_delta. Both should reach onOutput.
			const assistantEvent = JSON.stringify({
				type: "assistant",
				message: {
					content: [{ type: "text", text: "Resolving conflict in src/foo.ts\n" }],
				},
			});
			const deltaEvent = JSON.stringify({
				type: "content_block_delta",
				delta: { text: "Committed merge resolution.\n" },
			});
			const { spawn } = makeSpawn({
				2: { exit: 1, stdout: "CONFLICT (content): Merge conflict in file.ts\n" },
				3: { stdout: "aaaaaaa0000000000000000000000000000000000\n" },
				4: { exit: 0, stdout: `${assistantEvent}\n${deltaEvent}\n` },
				7: { stdout: "bbbbbbb0000000000000000000000000000000000\n" },
			});
			const outputs: string[] = [];
			await resolveConflicts("/tmp/worktree", "feature summary", (msg) => outputs.push(msg), {
				spawn,
			});

			const joined = outputs.join("\n");
			expect(joined).toContain("Resolving conflict in src/foo.ts");
			expect(joined).toContain("Committed merge resolution.");
		});

		test("throws when HEAD did not advance after Claude ran (Claude aborted the merge)", async () => {
			// Pre- and post-Claude HEAD snapshots return the same SHA → Claude
			// produced no new commits. This must surface loud instead of looping.
			const { spawn } = makeSpawn({
				2: {
					exit: 1,
					stdout: "CONFLICT (content): Merge conflict in file.ts\n",
				},
				3: { stdout: "aaaaaaa0000000000000000000000000000000000\n" },
				7: { stdout: "aaaaaaa0000000000000000000000000000000000\n" },
			});
			const promise = resolveConflicts("/tmp/worktree", "feature summary", () => {}, {
				spawn,
			});
			expect(promise).rejects.toThrow("no new commits");
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
				3: { stdout: "aaaaaaa0000000000000000000000000000000000\n" },
				5: { stdout: " M file.ts\n" }, // git status --porcelain → dirty
				6: { stdout: "chore: resolve merge conflicts with master\n" }, // last log
				10: { stdout: "bbbbbbb0000000000000000000000000000000000\n" },
			});
			await resolveConflicts("/tmp/worktree", "feature summary", () => {}, { spawn });

			// fetch, merge, pre-head, claude, status, log, add, amend, push, post-head
			expect(calls.length).toBe(10);
			expect(calls[6]).toEqual(["git", "add", "."]);
			expect(calls[7]).toEqual(["git", "commit", "--amend", "--no-edit"]);
			expect(calls[8]).toEqual(["git", "push"]);
		});

		test("creates new commit when last commit is not merge-conflict commit", async () => {
			const { calls, spawn } = makeSpawn({
				2: {
					exit: 1,
					stdout: "CONFLICT (content): Merge conflict in file.ts\n",
				},
				3: { stdout: "aaaaaaa0000000000000000000000000000000000\n" },
				5: { stdout: " M file.ts\n" },
				6: { stdout: "feat: some other commit\n" },
				10: { stdout: "bbbbbbb0000000000000000000000000000000000\n" },
			});
			await resolveConflicts("/tmp/worktree", "feature summary", () => {}, { spawn });

			// fetch, merge, pre-head, claude, status, log, add, commit, push, post-head
			expect(calls.length).toBe(10);
			expect(calls[6]).toEqual(["git", "add", "."]);
			expect(calls[7]).toEqual([
				"git",
				"commit",
				"-m",
				"chore: resolve merge conflicts with master",
			]);
			expect(calls[8]).toEqual(["git", "push"]);
		});

		test("throws when Claude CLI exits with non-zero code", async () => {
			const { spawn } = makeSpawn({
				2: { exit: 1, stdout: "CONFLICT (content): Merge conflict in file.ts\n" },
				3: { stdout: "aaaaaaa0000000000000000000000000000000000\n" },
				4: { exit: 1, stderr: "Claude error output" },
			});
			const promise = resolveConflicts("/tmp/worktree", "feature summary", () => {}, {
				spawn,
			});
			expect(promise).rejects.toThrow("Conflict resolution failed");
		});
	});
});
