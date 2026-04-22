import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertQueue } from "../../src/alert-queue";
import { AlertStore } from "../../src/alert-store";
import type { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type { ClientMessage, Workflow } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

// ── Module mocks ──────────────────────────────────────────────────────

// Import the real git-logger module BEFORE installing the mock so we can
// restore it in afterAll. Bun's mock.module replaces the module for the rest
// of the test run, which otherwise pollutes later files (e.g.
// claude-md-merger.test.ts) that rely on the real gitSpawn.
import * as realGitLogger from "../../src/git-logger";

const gitSpawnCalls: { args: string[]; cwd?: string }[] = [];
type GitSpawnImpl = (
	args: string[],
	opts?: { cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

// Default: delegate to a real spawn. Bun `mock.module` persists for the
// whole test run, so if this file's mocked impl were the default, other
// test files exercising the real `gitSpawn` (e.g. claude-md-guard) would
// see empty {code:0, stdout:"", stderr:""} and misbehave.
const realGitSpawnImpl: GitSpawnImpl = async (args, opts) => {
	const proc = Bun.spawn(args, {
		cwd: opts?.cwd,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const code = await proc.exited;
	const stdout = await new Response(proc.stdout as ReadableStream).text();
	const stderr = await new Response(proc.stderr as ReadableStream).text();
	return { code, stdout, stderr };
};
const trackingGitSpawnImpl: GitSpawnImpl = async (args, opts) => {
	gitSpawnCalls.push({ args, cwd: opts?.cwd });
	return { code: 0, stdout: "", stderr: "" };
};
let gitSpawnImpl: GitSpawnImpl = realGitSpawnImpl;

mock.module("../../src/git-logger", () => ({
	gitSpawn: (args: string[], opts?: { cwd?: string }) => gitSpawnImpl(args, opts),
}));

import { handlePurgeAll } from "../../src/server/purge-handlers";

afterAll(() => {
	mock.module("../../src/git-logger", () => realGitLogger);
});

describe("purge-handlers", () => {
	let tmpRepo: string;

	beforeAll(() => {
		tmpRepo = mkdtempSync(join(tmpdir(), "purge-test-"));
		gitSpawnImpl = trackingGitSpawnImpl;
	});

	afterAll(() => {
		rmSync(tmpRepo, { recursive: true, force: true });
		gitSpawnImpl = realGitSpawnImpl;
	});

	describe("handlePurgeAll", () => {
		test("aborts running orchestrators and clears map", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handlePurgeAll>[0];

			const abortCalls: string[] = [];
			const wf = makeWorkflow({ status: "running" });
			const mockOrch = {
				getEngine() {
					return {
						getWorkflow() {
							return wf;
						},
					};
				},
				abortPipeline(id: string) {
					abortCalls.push(id);
				},
			} as unknown as PipelineOrchestrator;

			const orchestrators = new Map<string, PipelineOrchestrator>();
			orchestrators.set(wf.id, mockOrch);

			const { deps, broadcastedMessages } = createMockHandlerDeps({ orchestrators });

			await handlePurgeAll(mockWs, { type: "purge:all" } as ClientMessage, deps);

			expect(abortCalls).toHaveLength(1);
			expect(abortCalls[0]).toBe(wf.id);
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

		test("clears the alert queue and broadcasts alert:dismissed for live clients", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handlePurgeAll>[0];

			// Real AlertQueue over a temp directory so we also verify the
			// persisted `alerts.json` is empty after purge — a stale file would
			// resurrect "purged" alerts on the next server restart.
			const alertDir = mkdtempSync(join(tmpdir(), "purge-alerts-"));
			const store = new AlertStore(alertDir);
			const alertQueue = new AlertQueue(store, { dedupWindowMs: 0 });
			try {
				const a = alertQueue.emit({
					type: "workflow-finished",
					title: "A",
					description: "",
					workflowId: "wf-a",
					epicId: null,
					targetRoute: "/workflow/wf-a",
				});
				const b = alertQueue.emit({
					type: "error",
					title: "B",
					description: "",
					workflowId: "wf-b",
					epicId: null,
					targetRoute: "/workflow/wf-b",
				});
				await alertQueue.flush();
				expect(alertQueue.list()).toHaveLength(2);

				const { deps, broadcastedMessages } = createMockHandlerDeps({ alertQueue });

				await handlePurgeAll(mockWs, { type: "purge:all" } as ClientMessage, deps);

				expect(alertQueue.list()).toHaveLength(0);
				await alertQueue.flush();
				expect(await store.load()).toEqual([]);

				if (!a || !b) throw new Error("emit returned null");
				const dismissed = broadcastedMessages.find((m) => m.type === "alert:dismissed");
				expect(dismissed).toBeTruthy();
				expect(new Set((dismissed as { alertIds: string[] }).alertIds)).toEqual(
					new Set([a.alert.id, b.alert.id]),
				);
			} finally {
				rmSync(alertDir, { recursive: true, force: true });
			}
		});

		test("no alert:dismissed broadcast when the queue was already empty", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handlePurgeAll>[0];

			const { deps, broadcastedMessages } = createMockHandlerDeps();
			await handlePurgeAll(mockWs, { type: "purge:all" } as ClientMessage, deps);

			expect(broadcastedMessages.some((m) => m.type === "alert:dismissed")).toBe(false);
			expect(broadcastedMessages.some((m) => m.type === "purge:complete")).toBe(true);
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
