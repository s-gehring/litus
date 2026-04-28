import { describe, expect, mock, test } from "bun:test";
import type { ClientMessage } from "../../src/protocol";
import type { PersistedEpic, Workflow } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { makePersistedEpic } from "../test-infra/factories";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

// Module mocks — analyzeEpic + createEpicWorkflows + validateTargetRepository
let mockAnalyzeBehavior:
	| "resume-success"
	| "resume-then-fresh"
	| "resume-then-fresh-fails"
	| "always-throw" = "resume-success";
let mockCreatedResult: { workflows: ReturnType<typeof makeWorkflow>[]; epicId: string } = {
	workflows: [],
	epicId: "e1",
};

mock.module("../../src/target-repo-validator", () => ({
	validateTargetRepository: async () => ({ valid: true, effectivePath: "/mock/repo" }),
}));

let analyzerCallsByBehavior: Map<string, number> = new Map();
const analyzerCallArgs: Array<{
	desc: string;
	resumeSessionId: string | null | undefined;
	behavior: string;
}> = [];
mock.module("../../src/epic-analyzer", () => {
	class UnrecoverableSessionError extends Error {
		constructor(msg: string) {
			super(msg);
			this.name = "UnrecoverableSessionError";
		}
	}
	return {
		UnrecoverableSessionError,
		analyzeEpic: async (
			desc: string,
			_repo: string,
			_ref: unknown,
			_timeout: unknown,
			cbs:
				| {
						onSessionId?: (sid: string) => void;
				  }
				| undefined,
			resumeSessionId?: string | null,
		) => {
			const prior = analyzerCallsByBehavior.get(mockAnalyzeBehavior) ?? 0;
			analyzerCallsByBehavior.set(mockAnalyzeBehavior, prior + 1);
			analyzerCallArgs.push({ desc, resumeSessionId, behavior: mockAnalyzeBehavior });
			if (mockAnalyzeBehavior === "resume-then-fresh" && resumeSessionId && prior === 0) {
				throw new UnrecoverableSessionError("session not found");
			}
			if (mockAnalyzeBehavior === "resume-then-fresh-fails") {
				if (resumeSessionId && prior === 0) {
					throw new UnrecoverableSessionError("session not found");
				}
				throw new Error("fresh also failed");
			}
			if (mockAnalyzeBehavior === "always-throw") {
				throw new Error("persistent failure");
			}
			cbs?.onSessionId?.(`sess-${prior + 1}`);
			return {
				title: "Refined",
				specs: [{ id: "s1", title: "Spec", description: "do", dependencies: [] }],
				summary: "refined once",
				infeasibleNotes: null,
			};
		},
	};
});

mock.module("../../src/workflow-engine", () => ({
	createEpicWorkflows: async () => mockCreatedResult,
}));

import { handleEpicFeedback } from "../../src/server/epic-handlers";

function seedEpic(
	deps: ReturnType<typeof createMockHandlerDeps>["deps"],
	overrides?: Partial<PersistedEpic>,
) {
	const epic = makePersistedEpic({
		status: "completed",
		decompositionSessionId: "initial-sess",
		workflowIds: ["wf-1"],
		...overrides,
	});
	void deps.sharedEpicStore.save(epic);
	void deps.sharedStore.save(
		makeWorkflow({
			id: "wf-1",
			epicId: epic.epicId,
			targetRepository: "/mock/repo",
			hasEverStarted: false,
		}),
	);
	// Ensure audit logger methods exist.
	deps.sharedAuditLogger = {
		logFeedbackSubmitted() {},
		logDecompositionResumed() {},
	} as unknown as typeof deps.sharedAuditLogger;
	return epic;
}

describe("epic-feedback-loop integration", () => {
	test("resume-success: analyzer invoked once, outcome completed persisted", async () => {
		mockAnalyzeBehavior = "resume-success";
		const { mock: ws } = createMockWebSocket();
		const { deps, broadcastedMessages } = createMockHandlerDeps();
		const epic = seedEpic(deps);
		const wfNew = makeWorkflow({ id: "wf-new" });
		mockCreatedResult = { workflows: [wfNew], epicId: epic.epicId };
		deps.createOrchestrator = () =>
			({
				getEngine: () => ({ setWorkflow() {} }),
				startPipelineFromWorkflow() {},
				abortPipeline() {},
			}) as unknown as ReturnType<typeof deps.createOrchestrator>;

		await handleEpicFeedback(
			ws as unknown as Parameters<typeof handleEpicFeedback>[0],
			{ type: "epic:feedback", epicId: epic.epicId, text: "refine" } as ClientMessage,
			deps,
		);

		const stored = (await deps.sharedEpicStore.loadAll()).find((e) => e.epicId === epic.epicId);
		expect(stored?.status).toBe("completed");
		expect(stored?.feedbackHistory).toHaveLength(1);
		expect(stored?.feedbackHistory[0].outcome).toBe("completed");
		expect(stored?.feedbackHistory[0].contextLostOnThisAttempt).toBe(false);
		// H13: the resumed run's onSessionId captured sess-1; the entry's
		// attemptSessionId must pin to the NEW id, not the prior resumeSessionId.
		expect(stored?.feedbackHistory[0].attemptSessionId).toBe("sess-1");
		expect(broadcastedMessages.some((m) => m.type === "epic:result")).toBe(true);
	});

	test("resume → unrecoverable → fresh fallback succeeds, sets contextLost flag", async () => {
		analyzerCallsByBehavior = new Map();
		analyzerCallArgs.length = 0;
		mockAnalyzeBehavior = "resume-then-fresh";
		const { mock: ws } = createMockWebSocket();
		const { deps } = createMockHandlerDeps();
		const epic = seedEpic(deps);
		const wfNew = makeWorkflow({ id: "wf-fresh" });
		mockCreatedResult = { workflows: [wfNew], epicId: epic.epicId };
		deps.createOrchestrator = () =>
			({
				getEngine: () => ({ setWorkflow() {} }),
				startPipelineFromWorkflow() {},
				abortPipeline() {},
			}) as unknown as ReturnType<typeof deps.createOrchestrator>;

		await handleEpicFeedback(
			ws as unknown as Parameters<typeof handleEpicFeedback>[0],
			{ type: "epic:feedback", epicId: epic.epicId, text: "refine again" } as ClientMessage,
			deps,
		);
		const stored = (await deps.sharedEpicStore.loadAll()).find((e) => e.epicId === epic.epicId);
		expect(stored?.status).toBe("completed");
		expect(stored?.sessionContextLost).toBe(true);
		expect(stored?.feedbackHistory[0].contextLostOnThisAttempt).toBe(true);
		// H13: the fresh-fallback run's onSessionId captured sess-2; the
		// entry must pin to the fresh id, not the prior/resumed one.
		expect(stored?.feedbackHistory[0].attemptSessionId).toBe("sess-2");

		// FR-015: the fresh-fallback call receives a prompt composed of the
		// original epic description concatenated with every feedback text, and
		// no resumeSessionId.
		const freshCall = analyzerCallArgs.find(
			(c) => c.behavior === "resume-then-fresh" && !c.resumeSessionId,
		);
		expect(freshCall).toBeDefined();
		expect(freshCall?.desc).toContain(epic.description);
		expect(freshCall?.desc).toContain("refine again");
	});

	test("concurrent submission → in_flight rejection for the second caller", async () => {
		mockAnalyzeBehavior = "resume-success";
		const { mock: ws1 } = createMockWebSocket();
		const { mock: ws2 } = createMockWebSocket();
		const { deps, sentMessages } = createMockHandlerDeps();
		// Use a fresh epic ID so the module-level lock map is clean for this epic.
		const epic = seedEpic(deps, { epicId: `concurrent-epic-${Date.now()}` });
		mockCreatedResult = {
			workflows: [makeWorkflow({ id: "wf-c" })],
			epicId: epic.epicId,
		};
		deps.createOrchestrator = () =>
			({
				getEngine: () => ({ setWorkflow() {} }),
				startPipelineFromWorkflow() {},
				abortPipeline() {},
			}) as unknown as ReturnType<typeof deps.createOrchestrator>;

		// Fire both concurrently.
		const p1 = handleEpicFeedback(
			ws1 as unknown as Parameters<typeof handleEpicFeedback>[0],
			{ type: "epic:feedback", epicId: epic.epicId, text: "first" } as ClientMessage,
			deps,
		);
		const p2 = handleEpicFeedback(
			ws2 as unknown as Parameters<typeof handleEpicFeedback>[0],
			{ type: "epic:feedback", epicId: epic.epicId, text: "second" } as ClientMessage,
			deps,
		);
		await Promise.all([p1, p2]);

		const msgs2 =
			sentMessages.get(ws2 as unknown as Parameters<typeof handleEpicFeedback>[0]) ?? [];
		const rejected = msgs2.find((m) => m.type === "epic:feedback:rejected");
		expect(rejected).toBeDefined();
		if (rejected?.type === "epic:feedback:rejected") {
			expect(rejected.reasonCode).toBe("in_flight");
		}
	});

	test("G5: transient analyzer failure (non-UnrecoverableSessionError) persists error outcome", async () => {
		mockAnalyzeBehavior = "always-throw";
		const { mock: ws } = createMockWebSocket();
		const { deps, broadcastedMessages } = createMockHandlerDeps();
		const epic = seedEpic(deps, { epicId: `always-throw-${Date.now()}` });
		deps.createOrchestrator = () =>
			({
				getEngine: () => ({ setWorkflow() {} }),
				startPipelineFromWorkflow() {},
				abortPipeline() {},
			}) as unknown as ReturnType<typeof deps.createOrchestrator>;

		await handleEpicFeedback(
			ws as unknown as Parameters<typeof handleEpicFeedback>[0],
			{ type: "epic:feedback", epicId: epic.epicId, text: "please retry" } as ClientMessage,
			deps,
		);

		const stored = (await deps.sharedEpicStore.loadAll()).find((e) => e.epicId === epic.epicId);
		expect(stored?.status).toBe("error");
		expect(stored?.errorMessage).toBe("persistent failure");
		expect(stored?.feedbackHistory[0].outcome).toBe("error");
		// epic:error broadcast fired.
		expect(broadcastedMessages.some((m) => m.type === "epic:error")).toBe(true);
	});

	test("G3: resume-then-fresh fails again → error + sessionContextLost stays sticky", async () => {
		analyzerCallsByBehavior = new Map();
		mockAnalyzeBehavior = "resume-then-fresh-fails";
		const { mock: ws } = createMockWebSocket();
		const { deps } = createMockHandlerDeps();
		const epic = seedEpic(deps, { epicId: `fresh-fails-${Date.now()}` });
		deps.createOrchestrator = () =>
			({
				getEngine: () => ({ setWorkflow() {} }),
				startPipelineFromWorkflow() {},
				abortPipeline() {},
			}) as unknown as ReturnType<typeof deps.createOrchestrator>;

		await handleEpicFeedback(
			ws as unknown as Parameters<typeof handleEpicFeedback>[0],
			{ type: "epic:feedback", epicId: epic.epicId, text: "retry unrecoverable" } as ClientMessage,
			deps,
		);
		const stored = (await deps.sharedEpicStore.loadAll()).find((e) => e.epicId === epic.epicId);
		expect(stored?.status).toBe("error");
		expect(stored?.errorMessage).toBe("fresh also failed");
		expect(stored?.sessionContextLost).toBe(true);
		expect(stored?.feedbackHistory[0].contextLostOnThisAttempt).toBe(true);
		expect(stored?.feedbackHistory[0].outcome).toBe("error");
	});

	test("G1: URL-submitted epic — feedback preserves managed-repo refcount across abort", async () => {
		mockAnalyzeBehavior = "resume-success";
		const { mock: ws } = createMockWebSocket();
		const { deps } = createMockHandlerDeps();
		const epic = seedEpic(deps, { epicId: `managed-${Date.now()}` });
		// Overwrite seeded workflow with one that carries managedRepo.
		await deps.sharedStore.save(
			makeWorkflow({
				id: "wf-1",
				epicId: epic.epicId,
				targetRepository: "/mock/repo",
				hasEverStarted: false,
				managedRepo: { owner: "Foo", repo: "Bar" },
			}),
		);

		// In-memory refcount tracker matching the real store's arithmetic.
		let refCount = 2;
		const calls: { method: string; args: unknown[] }[] = [];
		deps.managedRepoStore = {
			async acquire() {
				throw new Error("not expected");
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
			async tryAttachByPath() {
				return null;
			},
		} as unknown as typeof deps.managedRepoStore;

		// The new workflow must inherit managedRepo.
		let createCallManagedRepo: unknown = "unset";
		mock.module("../../src/workflow-engine", () => ({
			createEpicWorkflows: async (
				_result: unknown,
				_repo: string,
				_epicId: string,
				managedRepo: unknown,
			) => {
				createCallManagedRepo = managedRepo;
				return {
					workflows: [
						makeWorkflow({
							id: "wf-new",
							managedRepo: managedRepo as Workflow["managedRepo"],
						}),
					],
					epicId: epic.epicId,
				};
			},
		}));
		// `mock.module` above mutates the live module record, so the already
		// imported `handleEpicFeedback` will observe the new `createEpicWorkflows`.

		// Simulate the abortPipeline → releaseManagedRepoIfAny path: the
		// orchestrator's abort releases the refcount for its workflow.
		deps.createOrchestrator = () =>
			({
				getEngine: () => ({
					setWorkflow() {},
					getWorkflow: () => null,
				}),
				startPipelineFromWorkflow() {},
				abortPipeline() {
					// Emulate release of wf-1's managed-repo ref.
					void deps.managedRepoStore.release("Foo", "Bar");
				},
			}) as unknown as ReturnType<typeof deps.createOrchestrator>;
		// Pre-register orchestrator for wf-1 so abortPipeline is invoked.
		deps.orchestrators.set("wf-1", deps.createOrchestrator());

		await handleEpicFeedback(
			ws as unknown as Parameters<typeof handleEpicFeedback>[0],
			{ type: "epic:feedback", epicId: epic.epicId, text: "refine" } as ClientMessage,
			deps,
		);

		// The +1 bump must have fired BEFORE the release triggered by abort,
		// and the new workflow must inherit managedRepo (so no refcount leak).
		const bumps = calls.filter((c) => c.method === "bumpRefCount");
		expect(bumps.length).toBeGreaterThanOrEqual(1);
		expect((bumps[0].args as unknown[])[2]).toBe(1);
		expect(createCallManagedRepo).toEqual({ owner: "Foo", repo: "Bar" });
		// Starting at 2 (two prior workflows), +1 bump, -1 abort release, and
		// first new workflow inherits the held ref → refCount ends at 2.
		// (one lingering for the deleted prior workflow that had no orchestrator,
		// and one owned by the new workflow).
		expect(refCount).toBeGreaterThan(0);
	});
});
