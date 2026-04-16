import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type { ClientMessage, Workflow } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

// ── Module mocks ──────────────────────────────────────────────────────

const gitSpawnCalls: { args: string[]; cwd?: string }[] = [];
let gitSpawnImpl: (
	args: string[],
	opts?: { cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }> = async (args, opts) => {
	gitSpawnCalls.push({ args, cwd: opts?.cwd });
	return { code: 0, stdout: "", stderr: "" };
};

mock.module("../../src/git-logger", () => ({
	gitSpawn: (args: string[], opts?: { cwd?: string }) => gitSpawnImpl(args, opts),
}));

import { handlePurgeAll } from "../../src/server/purge-handlers";

describe("purge-handlers", () => {
	let tmpRepo: string;

	beforeAll(() => {
		tmpRepo = mkdtempSync(join(tmpdir(), "purge-test-"));
	});

	afterAll(() => {
		rmSync(tmpRepo, { recursive: true, force: true });
	});

	describe("handlePurgeAll", () => {
		test("cancels running orchestrators and clears map", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handlePurgeAll>[0];

			const cancelCalls: string[] = [];
			const wf = makeWorkflow({ status: "running" });
			const mockOrch = {
				getEngine() {
					return {
						getWorkflow() {
							return wf;
						},
					};
				},
				cancelPipeline(id: string) {
					cancelCalls.push(id);
				},
			} as unknown as PipelineOrchestrator;

			const orchestrators = new Map<string, PipelineOrchestrator>();
			orchestrators.set(wf.id, mockOrch);

			const { deps, broadcastedMessages } = createMockHandlerDeps({ orchestrators });

			await handlePurgeAll(mockWs, { type: "purge:all" } as ClientMessage, deps);

			expect(cancelCalls).toHaveLength(1);
			expect(cancelCalls[0]).toBe(wf.id);
			expect(orchestrators.size).toBe(0);
			expect(broadcastedMessages.some((m) => m.type === "purge:complete")).toBe(true);
		});

		test("kills active epic analysis", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handlePurgeAll>[0];

			const { deps } = createMockHandlerDeps();
			let killed = false;
			deps.epicAnalysisRef.current = {
				kill() {
					killed = true;
				},
			} as unknown as typeof deps.epicAnalysisRef.current;

			await handlePurgeAll(mockWs, { type: "purge:all" } as ClientMessage, deps);

			expect(killed).toBe(true);
			expect(deps.epicAnalysisRef.current).toBeNull();
		});

		test("removes worktrees and deletes branches", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handlePurgeAll>[0];

			const wf = makeWorkflow({
				status: "completed",
				targetRepository: tmpRepo,
				worktreePath: `${tmpRepo}/.worktrees/test-branch`,
				featureBranch: "feat-branch",
			});

			// Override sharedStore.loadAll to return our workflow
			const { deps, broadcastedMessages } = createMockHandlerDeps();
			deps.sharedStore.loadAll = async () => [wf as Workflow];

			gitSpawnCalls.length = 0;

			await handlePurgeAll(mockWs, { type: "purge:all" } as ClientMessage, deps);

			// Should have called git worktree remove, git worktree prune, and git branch -D
			const worktreeRemove = gitSpawnCalls.find(
				(c) => c.args.includes("worktree") && c.args.includes("remove"),
			);
			expect(worktreeRemove).toBeTruthy();

			const branchDelete = gitSpawnCalls.find(
				(c) => c.args.includes("branch") && c.args.includes("-D"),
			);
			expect(branchDelete).toBeTruthy();
			expect(branchDelete?.args).toContain("feat-branch");

			expect(broadcastedMessages.some((m) => m.type === "purge:complete")).toBe(true);
		});

		test("broadcasts progress updates during purge", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handlePurgeAll>[0];

			const { deps, broadcastedMessages } = createMockHandlerDeps();

			await handlePurgeAll(mockWs, { type: "purge:all" } as ClientMessage, deps);

			expect(broadcastedMessages.some((m) => m.type === "purge:progress")).toBe(true);
			expect(broadcastedMessages.some((m) => m.type === "purge:complete")).toBe(true);
		});

		test("silently skips missing repositories (already-gone = success)", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handlePurgeAll>[0];

			const wf = makeWorkflow({
				status: "completed",
				targetRepository: "/nonexistent/path/xyz-purge",
				worktreePath: "/nonexistent/path/xyz-purge/.worktrees/wt",
				featureBranch: "some-branch",
			});

			const { deps, broadcastedMessages } = createMockHandlerDeps();
			deps.sharedStore.loadAll = async () => [wf as Workflow];
			gitSpawnCalls.length = 0;

			await handlePurgeAll(mockWs, { type: "purge:all" } as ClientMessage, deps);

			// No git commands for the missing repo, and no user-facing warnings —
			// an already-gone repo is the desired end state.
			expect(gitSpawnCalls.length).toBe(0);

			const complete = broadcastedMessages.find((m) => m.type === "purge:complete");
			expect(complete).toBeTruthy();
			expect((complete as { warnings: string[] }).warnings).toEqual([]);
		});

		test("broadcasts purge:error when an unexpected failure aborts the handler", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handlePurgeAll>[0];

			const { deps, broadcastedMessages } = createMockHandlerDeps();
			// Force an unrecoverable failure inside the handler's main flow.
			deps.sharedStore.loadAll = async () => {
				throw new Error("boom");
			};

			await handlePurgeAll(mockWs, { type: "purge:all" } as ClientMessage, deps);

			const errMsg = broadcastedMessages.find((m) => m.type === "purge:error");
			expect(errMsg).toBeTruthy();
			expect((errMsg as { message: string }).message).toContain("boom");
			expect(broadcastedMessages.some((m) => m.type === "purge:complete")).toBe(false);
		});

		test("recovers when gitSpawn throws synchronously (e.g. ENOENT)", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handlePurgeAll>[0];

			const wf = makeWorkflow({
				status: "completed",
				targetRepository: tmpRepo,
				worktreePath: `${tmpRepo}/.worktrees/wt`,
				featureBranch: "feat-branch",
			});

			const { deps, broadcastedMessages } = createMockHandlerDeps();
			deps.sharedStore.loadAll = async () => [wf as Workflow];

			const prevImpl = gitSpawnImpl;
			gitSpawnImpl = async (_args) => {
				throw new Error("uv_spawn ENOENT");
			};
			try {
				await handlePurgeAll(mockWs, { type: "purge:all" } as ClientMessage, deps);
			} finally {
				gitSpawnImpl = prevImpl;
			}

			// Handler must not throw — progress should still complete with warnings
			const complete = broadcastedMessages.find((m) => m.type === "purge:complete");
			expect(complete).toBeTruthy();
			expect((complete as { warnings: string[] }).warnings.length).toBeGreaterThan(0);
		});
	});
});
