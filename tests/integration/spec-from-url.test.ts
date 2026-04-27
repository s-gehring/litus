import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSpawn } from "../../src/git-logger";
import { ManagedRepoStore } from "../../src/managed-repo-store";
import type { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type { ClientMessage } from "../../src/protocol";
import type { HandlerDeps } from "../../src/server/handler-types";
import { handleStart } from "../../src/server/workflow-handlers";
import { makeWorkflow } from "../helpers";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

// Other test files (notably tests/unit/epic-handlers.test.ts and
// tests/integration/epic-feedback-loop.test.ts) install
// `mock.module("../../src/target-repo-validator", …)` at their top level.
// Bun applies module mocks process-globally, and they persist across files.
// For this test we need a validator that recognises GitHub HTTPS / SSH URLs
// and returns the right `kind: "url"` envelope so `resolveTargetRepo`
// routes through the clone path. Mock with a small stand-alone implementation
// — re-importing the real module would still resolve to whatever mock the
// previously-loaded test installed.
mock.module("../../src/target-repo-validator", () => ({
	validateTargetRepository: async (path: string | undefined) => {
		if (!path) {
			return { valid: false, error: "Repository path is required", effectivePath: "" };
		}
		const trimmed = path.trim();
		const httpsMatch = trimmed.match(
			/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
		);
		const sshMatch = trimmed.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
		const m = httpsMatch ?? sshMatch;
		if (m) {
			return {
				valid: true,
				effectivePath: trimmed,
				kind: "url" as const,
				owner: m[1],
				repo: m[2],
			};
		}
		// Non-GitHub URL — surface the same error code production uses.
		if (/^https?:\/\//i.test(trimmed) || /^git@/i.test(trimmed)) {
			return {
				valid: false,
				error: "Only GitHub URLs are supported",
				effectivePath: trimmed,
				code: "non-github-url" as const,
			};
		}
		// Local path — assume it exists and is a git repo for the test.
		return { valid: true, effectivePath: trimmed, kind: "path" as const };
	},
}));

describe("spec-from-url integration", () => {
	let tmpBase: string;
	let bareRepoPath: string;

	function rmWithRetry(p: string): void {
		for (let i = 0; i < 20; i++) {
			try {
				rmSync(p, { recursive: true, force: true });
				return;
			} catch {
				// Windows can hold file handles briefly after git ops; retry.
				Bun.sleepSync(100);
			}
		}
		rmSync(p, { recursive: true, force: true });
	}

	beforeEach(() => {
		tmpBase = mkdtempSync(join(tmpdir(), "sfu-"));
		const workDir = join(tmpBase, "work");
		bareRepoPath = join(tmpBase, "remote.git");
		execSync(`git init --bare -b main "${bareRepoPath}"`, { stdio: "ignore" });
		execSync(`git init -b main "${workDir}"`, { stdio: "ignore" });
		execSync(`git -C "${workDir}" -c user.email=a@b -c user.name=a commit --allow-empty -m init`, {
			stdio: "ignore",
		});
		execSync(`git -C "${workDir}" remote add origin "${bareRepoPath}"`, { stdio: "ignore" });
		execSync(`git -C "${workDir}" push origin main`, { stdio: "ignore" });
	}, 30_000);

	afterEach(() => {
		rmWithRetry(tmpBase);
	}, 30_000);

	test("URL submission clones to baseDir, sets managedRepo, and emits clone events", async () => {
		const baseDir = join(tmpBase, "repos");
		const fakeUrl = "https://github.com/testuser/testrepo.git";

		const store = new ManagedRepoStore({
			baseDir,
			async runCmd(cmd, cwd) {
				// Make gh unavailable to force the git-clone fallback path
				if (cmd[0] === "gh") {
					return { code: -1, stdout: "", stderr: "", missing: true };
				}
				// Remap the fake github URL to our local bare fixture
				const remapped = cmd.map((a) => (a === fakeUrl ? bareRepoPath : a));
				const r = await gitSpawn(remapped, cwd ? { cwd } : undefined);
				return { ...r, missing: false };
			},
			async rm(p) {
				rmSync(p, { recursive: true, force: true });
			},
			async pathExists(p) {
				return existsSync(p);
			},
		});

		const { mock: ws } = createMockWebSocket();
		const wsTyped = ws as unknown as Parameters<typeof handleStart>[0];

		const startPipelineCalls: { spec: string; repo: string }[] = [];
		const mockOrch = {
			startPipeline: async (spec: string, repo: string) => {
				startPipelineCalls.push({ spec, repo });
				const wf = makeWorkflow({
					status: "running",
					targetRepository: repo,
					managedRepo: { owner: "testuser", repo: "testrepo" },
				});
				return wf;
			},
		} as unknown as PipelineOrchestrator;

		const { deps, broadcastedMessages } = createMockHandlerDeps({
			createOrchestrator: () => mockOrch,
			managedRepoStore: store,
		});

		await handleStart(
			wsTyped,
			{
				type: "workflow:start",
				specification: "Test spec",
				targetRepository: fakeUrl,
				submissionId: "sub-1",
			} as ClientMessage,
			deps,
		);

		const clonedRepoDir = join(baseDir, "testuser", "testrepo");
		expect(existsSync(join(clonedRepoDir, ".git"))).toBe(true);

		// Clone lifecycle events
		const startEvt = broadcastedMessages.find((m) => m.type === "repo:clone-start");
		expect(startEvt).toBeDefined();
		expect(broadcastedMessages.some((m) => m.type === "repo:clone-complete")).toBe(true);
		expect(broadcastedMessages.some((m) => m.type === "repo:clone-error")).toBe(false);

		// Orchestrator was called with the local clone path, not the URL
		expect(startPipelineCalls).toHaveLength(1);
		expect(startPipelineCalls[0].repo).toBe(clonedRepoDir);

		// Workflow broadcast carries managedRepo
		const created = broadcastedMessages.find((m) => m.type === "workflow:created");
		expect(created).toBeDefined();
		if (created && created.type === "workflow:created") {
			expect(created.workflow.targetRepository).toBe(clonedRepoDir);
			expect(created.workflow.managedRepo).toEqual({ owner: "testuser", repo: "testrepo" });
		}
	}, 60_000);

	test("second submission via SSH form does not clone again (integration-level dedupe)", async () => {
		const baseDir = join(tmpBase, "repos");
		const httpsUrl = "https://github.com/testuser/testrepo.git";
		const sshUrl = "git@github.com:testuser/testrepo.git";
		let cloneInvocationCount = 0;

		const store = new ManagedRepoStore({
			baseDir,
			async runCmd(cmd, cwd) {
				if (cmd[0] === "gh") {
					return { code: -1, stdout: "", stderr: "", missing: true };
				}
				if (cmd[0] === "git" && cmd[1] === "clone") {
					cloneInvocationCount++;
				}
				const remapped = cmd.map((a) => (a === httpsUrl || a === sshUrl ? bareRepoPath : a));
				const r = await gitSpawn(remapped, cwd ? { cwd } : undefined);
				return { ...r, missing: false };
			},
			async rm(p) {
				rmSync(p, { recursive: true, force: true });
			},
			async pathExists(p) {
				return existsSync(p);
			},
		});

		const { mock: ws } = createMockWebSocket();
		const wsTyped = ws as unknown as Parameters<typeof handleStart>[0];

		const makeOrch = () =>
			({
				startPipeline: async (_spec: string, repo: string) =>
					makeWorkflow({
						status: "running",
						targetRepository: repo,
						managedRepo: { owner: "testuser", repo: "testrepo" },
					}),
			}) as unknown as PipelineOrchestrator;

		const { deps } = createMockHandlerDeps({
			createOrchestrator: makeOrch,
			managedRepoStore: store,
		});

		await handleStart(
			wsTyped,
			{
				type: "workflow:start",
				specification: "First spec",
				targetRepository: httpsUrl,
				submissionId: "sub-1",
			} as ClientMessage,
			deps,
		);
		await handleStart(
			wsTyped,
			{
				type: "workflow:start",
				specification: "Second spec",
				targetRepository: sshUrl,
				submissionId: "sub-2",
			} as ClientMessage,
			deps,
		);

		// Only one git clone invocation; the second submission hit the ready-reuse branch.
		expect(cloneInvocationCount).toBe(1);
	}, 60_000);

	test("non-GitHub URL produces clone-error and no workflow is created", async () => {
		const baseDir = join(tmpBase, "repos");

		const store = new ManagedRepoStore({
			baseDir,
			async runCmd() {
				throw new Error("runCmd must not be called for non-GitHub URLs");
			},
			async rm() {},
			async pathExists() {
				return false;
			},
		});

		const { mock: ws } = createMockWebSocket();
		const wsTyped = ws as unknown as Parameters<typeof handleStart>[0];

		let orchCreated = 0;
		const { deps, broadcastedMessages, sentMessages } = createMockHandlerDeps({
			createOrchestrator: (() => {
				orchCreated++;
				throw new Error("createOrchestrator must not be called when URL is rejected");
			}) as unknown as HandlerDeps["createOrchestrator"],
			managedRepoStore: store,
		});

		await handleStart(
			wsTyped,
			{
				type: "workflow:start",
				specification: "Should not run",
				targetRepository: "https://gitlab.com/foo/bar.git",
				submissionId: "sub-reject",
			} as ClientMessage,
			deps,
		);

		expect(orchCreated).toBe(0);
		expect(broadcastedMessages.some((m) => m.type === "workflow:created")).toBe(false);

		// clone-error is unicast to the submitting socket (see F5 fix)
		const perSocket = sentMessages.get(ws as unknown as Parameters<HandlerDeps["sendTo"]>[0]);
		const cloneErr = perSocket?.find((m) => m.type === "repo:clone-error");
		expect(cloneErr).toBeDefined();
		if (cloneErr && cloneErr.type === "repo:clone-error") {
			expect(cloneErr.code).toBe("non-github-url");
		}
	});
});
