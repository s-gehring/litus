import { describe, expect, mock, test } from "bun:test";
import type { ManagedRepoStore } from "../../src/managed-repo-store";
import type { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type { ClientMessage } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

// ── Module mocks ──────────────────────────────────────────────────────

type MockValidation = {
	valid: boolean;
	error?: string;
	effectivePath: string;
	kind?: "url" | "path";
	owner?: string;
	repo?: string;
	code?: "non-github-url";
};

let mockValidationResult: MockValidation = {
	valid: true,
	effectivePath: "/mock/repo",
};
let mockAnalyzeResult: {
	title: string;
	specs: { title: string; specification: string }[];
	summary?: string;
	infeasibleNotes?: string;
} = { title: "Test Epic", specs: [] };
let mockCreatedWorkflows: { workflows: ReturnType<typeof makeWorkflow>[]; epicId: string } = {
	workflows: [],
	epicId: "epic-1",
};

mock.module("../../src/target-repo-validator", () => ({
	validateTargetRepository: async () => mockValidationResult,
}));

mock.module("../../src/epic-analyzer", () => ({
	analyzeEpic: async () => mockAnalyzeResult,
}));

mock.module("../../src/workflow-engine", () => ({
	createEpicWorkflows: async () => mockCreatedWorkflows,
}));

import { handleEpicAbort, handleEpicStart } from "../../src/server/epic-handlers";

function setup() {
	const { mock: ws } = createMockWebSocket();
	const mockWs = ws as unknown as Parameters<typeof handleEpicAbort>[0];
	const { deps, sentMessages, broadcastedMessages } = createMockHandlerDeps({
		sharedSummarizer: {
			generateSpecSummary: async () => ({ summary: null }),
		} as unknown as typeof deps.sharedSummarizer,
	});
	return { ws: mockWs, deps, sentMessages, broadcastedMessages };
}

describe("epic-handlers", () => {
	describe("handleEpicStart", () => {
		test("rejects description shorter than 10 characters", async () => {
			const { ws, deps, sentMessages } = setup();

			await handleEpicStart(
				ws,
				{
					type: "epic:start",
					description: "short",
					targetRepository: "/mock/repo",
					autoStart: false,
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(
				msgs.some(
					(m) =>
						m.type === "error" && m.message === "Epic description must be at least 10 characters",
				),
			).toBe(true);
		});

		test("rejects invalid target repository", async () => {
			const { ws, deps, sentMessages } = setup();
			mockValidationResult = { valid: false, error: "Not a git repo", effectivePath: "/bad" };

			await handleEpicStart(
				ws,
				{
					type: "epic:start",
					description: "A valid long description",
					targetRepository: "/bad",
					autoStart: false,
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(msgs.some((m) => m.type === "error" && m.message === "Not a git repo")).toBe(true);
		});

		test("broadcasts infeasible when specs are empty with infeasibleNotes", async () => {
			const { ws, deps, broadcastedMessages } = setup();
			mockValidationResult = { valid: true, effectivePath: "/mock/repo" };
			mockAnalyzeResult = {
				title: "Impossible Epic",
				specs: [],
				infeasibleNotes: "Cannot be done because X",
			};

			await handleEpicStart(
				ws,
				{
					type: "epic:start",
					description: "A valid long description for infeasible",
					targetRepository: "/mock/repo",
					autoStart: false,
				} as ClientMessage,
				deps,
			);

			expect(broadcastedMessages.some((m) => m.type === "epic:created")).toBe(true);
			expect(broadcastedMessages.some((m) => m.type === "epic:infeasible")).toBe(true);
			expect(broadcastedMessages.some((m) => m.type === "epic:result")).toBe(false);
		});

		test("creates workflows and broadcasts result on success", async () => {
			const { ws, deps, broadcastedMessages } = setup();
			mockValidationResult = { valid: true, effectivePath: "/mock/repo" };
			const wf1 = makeWorkflow({ epicDependencyStatus: "satisfied" });
			const wf2 = makeWorkflow({ epicDependencyStatus: "waiting" });
			mockAnalyzeResult = {
				title: "Good Epic",
				specs: [
					{ title: "Spec 1", specification: "Do thing 1" },
					{ title: "Spec 2", specification: "Do thing 2" },
				],
				summary: "Two specs",
			};
			mockCreatedWorkflows = { workflows: [wf1, wf2], epicId: "epic-1" };

			const startCalls: unknown[][] = [];
			const mockOrch = {
				getEngine() {
					return {
						setWorkflow() {},
					};
				},
				startPipelineFromWorkflow(...args: unknown[]) {
					startCalls.push(args);
				},
			} as unknown as PipelineOrchestrator;

			deps.createOrchestrator = () => mockOrch;

			await handleEpicStart(
				ws,
				{
					type: "epic:start",
					description: "A valid long description for success",
					targetRepository: "/mock/repo",
					autoStart: true,
				} as ClientMessage,
				deps,
			);

			expect(broadcastedMessages.some((m) => m.type === "epic:created")).toBe(true);
			expect(broadcastedMessages.some((m) => m.type === "epic:result")).toBe(true);
			expect(broadcastedMessages.filter((m) => m.type === "workflow:created")).toHaveLength(2);
			expect(deps.orchestrators.has(wf1.id)).toBe(true);
			expect(deps.orchestrators.has(wf2.id)).toBe(true);
			// autoStart: only the satisfied-dependency workflow should be started
			expect(startCalls).toHaveLength(1);
		});

		test("broadcasts error when analysis throws", async () => {
			const { ws, deps, broadcastedMessages } = setup();
			mockValidationResult = { valid: true, effectivePath: "/mock/repo" };

			// Override the mock to throw
			mock.module("../../src/epic-analyzer", () => ({
				analyzeEpic: async () => {
					throw new Error("CLI crashed");
				},
			}));
			// Re-import to pick up the new mock
			const { handleEpicStart: freshHandler } = await import("../../src/server/epic-handlers");

			await freshHandler(
				ws,
				{
					type: "epic:start",
					description: "A valid long description for error",
					targetRepository: "/mock/repo",
					autoStart: false,
				} as ClientMessage,
				deps,
			);

			expect(broadcastedMessages.some((m) => m.type === "epic:error")).toBe(true);

			// Restore the original mock
			mock.module("../../src/epic-analyzer", () => ({
				analyzeEpic: async () => mockAnalyzeResult,
			}));
		});
	});

	describe("handleEpicStart — URL branch (managed-repo lifecycle)", () => {
		// A tiny in-memory refcount tracker that matches the real store's
		// acquire/bump/release arithmetic. Lets us assert the handler's invariant
		// (refCount == persisted workflows) across success/failure paths.
		function makeTrackedRepoStore() {
			let refCount = 0;
			const calls: { method: string; args: unknown[] }[] = [];
			const store = {
				async acquire(_sid: string, _url: string) {
					calls.push({ method: "acquire", args: [_sid, _url] });
					refCount += 1;
					return { owner: "Foo", repo: "Bar", path: "/mock/clones/Foo/Bar", reused: false };
				},
				async release(owner: string, repo: string) {
					calls.push({ method: "release", args: [owner, repo] });
					if (refCount > 0) refCount -= 1;
				},
				async bumpRefCount(owner: string, repo: string, by: number) {
					calls.push({ method: "bumpRefCount", args: [owner, repo, by] });
					refCount += by;
				},
				async seedFromWorkflows() {},
			} as unknown as ManagedRepoStore;
			return { store, getRefCount: () => refCount, calls };
		}

		test("URL input with N=2 specs: bump(1) once, refCount ends at N after all saves succeed", async () => {
			const { ws, deps } = setup();
			mockValidationResult = {
				valid: true,
				effectivePath: "https://github.com/Foo/Bar.git",
				kind: "url",
				owner: "Foo",
				repo: "Bar",
			};
			const wf1 = makeWorkflow({ epicDependencyStatus: "satisfied" });
			const wf2 = makeWorkflow({ epicDependencyStatus: "satisfied" });
			mockAnalyzeResult = {
				title: "URL Epic",
				specs: [
					{ title: "Spec 1", specification: "S1" },
					{ title: "Spec 2", specification: "S2" },
				],
			};
			mockCreatedWorkflows = { workflows: [wf1, wf2], epicId: "epic-url-1" };

			const { store, getRefCount, calls } = makeTrackedRepoStore();
			deps.managedRepoStore = store;
			deps.createOrchestrator = () =>
				({
					getEngine: () => ({ setWorkflow() {} }),
					startPipelineFromWorkflow() {},
				}) as unknown as PipelineOrchestrator;

			await handleEpicStart(
				ws,
				{
					type: "epic:start",
					description: "A valid long description for URL",
					targetRepository: "https://github.com/Foo/Bar.git",
					autoStart: false,
					submissionId: "sub-1",
				} as ClientMessage,
				deps,
			);

			expect(calls.filter((c) => c.method === "acquire")).toHaveLength(1);
			expect(calls.filter((c) => c.method === "bumpRefCount")).toHaveLength(1);
			expect(calls.filter((c) => c.method === "bumpRefCount")[0].args[2]).toBe(1);
			expect(calls.filter((c) => c.method === "release")).toHaveLength(0);
			expect(getRefCount()).toBe(2);
		});

		test("URL input with save throwing on iteration 1: refCount collapses to (persisted count)", async () => {
			const { ws, deps } = setup();
			mockValidationResult = {
				valid: true,
				effectivePath: "https://github.com/Foo/Bar.git",
				kind: "url",
				owner: "Foo",
				repo: "Bar",
			};
			const wf1 = makeWorkflow({ epicDependencyStatus: "satisfied" });
			const wf2 = makeWorkflow({ epicDependencyStatus: "satisfied" });
			mockAnalyzeResult = {
				title: "URL Epic Save Fail",
				specs: [
					{ title: "Spec 1", specification: "S1" },
					{ title: "Spec 2", specification: "S2" },
				],
			};
			mockCreatedWorkflows = { workflows: [wf1, wf2], epicId: "epic-save-fail" };

			const { store, getRefCount, calls } = makeTrackedRepoStore();
			deps.managedRepoStore = store;
			deps.createOrchestrator = () =>
				({
					getEngine: () => ({ setWorkflow() {} }),
					startPipelineFromWorkflow() {},
				}) as unknown as PipelineOrchestrator;

			// Save throws on iteration 1 (second workflow).
			let saveCalls = 0;
			deps.sharedStore.save = async () => {
				saveCalls += 1;
				if (saveCalls === 2) throw new Error("disk full");
			};

			await handleEpicStart(
				ws,
				{
					type: "epic:start",
					description: "A valid long description for URL save fail",
					targetRepository: "https://github.com/Foo/Bar.git",
					autoStart: false,
					submissionId: "sub-2",
				} as ClientMessage,
				deps,
			);

			// acquire once, bump(1) once (for iter 1 before its save throws),
			// release once (the initial acquire, from `finally`).
			expect(calls.filter((c) => c.method === "acquire")).toHaveLength(1);
			expect(calls.filter((c) => c.method === "bumpRefCount")).toHaveLength(1);
			expect(calls.filter((c) => c.method === "release")).toHaveLength(1);
			// One workflow persisted (wf1). refCount should equal the number of
			// persisted workflows so each will eventually drive it to 0 via its
			// orchestrator's release hook.
			expect(getRefCount()).toBe(1);
		});

		test("URL input with analyzeEpic throwing: release called from finally, refCount 0", async () => {
			const { ws, deps } = setup();
			mockValidationResult = {
				valid: true,
				effectivePath: "https://github.com/Foo/Bar.git",
				kind: "url",
				owner: "Foo",
				repo: "Bar",
			};
			const { store, getRefCount, calls } = makeTrackedRepoStore();
			deps.managedRepoStore = store;

			mock.module("../../src/epic-analyzer", () => ({
				analyzeEpic: async () => {
					throw new Error("boom");
				},
			}));
			const { handleEpicStart: freshHandler } = await import("../../src/server/epic-handlers");

			await freshHandler(
				ws,
				{
					type: "epic:start",
					description: "A valid long description for analyze fail",
					targetRepository: "https://github.com/Foo/Bar.git",
					autoStart: false,
					submissionId: "sub-3",
				} as ClientMessage,
				deps,
			);

			expect(calls.filter((c) => c.method === "acquire")).toHaveLength(1);
			expect(calls.filter((c) => c.method === "release")).toHaveLength(1);
			expect(getRefCount()).toBe(0);

			mock.module("../../src/epic-analyzer", () => ({
				analyzeEpic: async () => mockAnalyzeResult,
			}));
		});

		test("URL input with infeasible result: release called once, refCount 0", async () => {
			const { ws, deps } = setup();
			mockValidationResult = {
				valid: true,
				effectivePath: "https://github.com/Foo/Bar.git",
				kind: "url",
				owner: "Foo",
				repo: "Bar",
			};
			mockAnalyzeResult = {
				title: "Infeasible URL Epic",
				specs: [],
				infeasibleNotes: "Cannot because X",
			};
			const { store, getRefCount, calls } = makeTrackedRepoStore();
			deps.managedRepoStore = store;

			await handleEpicStart(
				ws,
				{
					type: "epic:start",
					description: "A valid long description for infeasible URL",
					targetRepository: "https://github.com/Foo/Bar.git",
					autoStart: false,
					submissionId: "sub-4",
				} as ClientMessage,
				deps,
			);

			expect(calls.filter((c) => c.method === "acquire")).toHaveLength(1);
			expect(calls.filter((c) => c.method === "release")).toHaveLength(1);
			expect(getRefCount()).toBe(0);
		});
	});

	describe("handleEpicAbort", () => {
		test("kills active epic analysis process", () => {
			const { ws, deps } = setup();
			let killed = false;
			deps.epicAnalysisRef.current = {
				kill() {
					killed = true;
				},
			} as unknown as typeof deps.epicAnalysisRef.current;

			handleEpicAbort(ws, { type: "epic:abort" } as ClientMessage, deps);

			expect(killed).toBe(true);
			expect(deps.epicAnalysisRef.current).toBeNull();
		});

		test("does nothing when no active analysis", () => {
			const { ws, deps } = setup();
			deps.epicAnalysisRef.current = null;

			// Should not throw
			handleEpicAbort(ws, { type: "epic:abort" } as ClientMessage, deps);
			expect(deps.epicAnalysisRef.current).toBeNull();
		});
	});
});
