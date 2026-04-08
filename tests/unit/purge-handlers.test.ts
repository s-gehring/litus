import { describe, expect, mock, test } from "bun:test";
import type { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type { ClientMessage, Workflow } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

// ── Module mocks ──────────────────────────────────────────────────────

const gitSpawnCalls: { args: string[]; cwd?: string }[] = [];

mock.module("../../src/git-logger", () => ({
	gitSpawn: async (args: string[], opts?: { cwd?: string }) => {
		gitSpawnCalls.push({ args, cwd: opts?.cwd });
		return { code: 0, stdout: "", stderr: "" };
	},
}));

import { handlePurgeAll } from "../../src/server/purge-handlers";

describe("purge-handlers", () => {
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
				targetRepository: "/mock/repo",
				worktreePath: "/mock/repo/.worktrees/test-branch",
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
	});
});
