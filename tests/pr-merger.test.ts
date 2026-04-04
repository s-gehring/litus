import { describe, expect, test } from "bun:test";
import { extractPrNumber, extractRepoFromUrl, mergePr } from "../src/pr-merger";

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
	});
});
