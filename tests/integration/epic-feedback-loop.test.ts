import { describe, expect, mock, test } from "bun:test";
import type { ClientMessage, PersistedEpic } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { makePersistedEpic } from "../test-infra/factories";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

// Module mocks — analyzeEpic + createEpicWorkflows + validateTargetRepository
let mockAnalyzeBehavior: "resume-success" | "resume-then-fresh" | "always-throw" = "resume-success";
let mockCreatedResult: { workflows: ReturnType<typeof makeWorkflow>[]; epicId: string } = {
	workflows: [],
	epicId: "e1",
};

mock.module("../../src/target-repo-validator", () => ({
	validateTargetRepository: async () => ({ valid: true, effectivePath: "/mock/repo" }),
}));

let analyzerCallsByBehavior: Map<string, number> = new Map();
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
			_desc: string,
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
			if (mockAnalyzeBehavior === "resume-then-fresh" && resumeSessionId && prior === 0) {
				throw new UnrecoverableSessionError("session not found");
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
		expect(broadcastedMessages.some((m) => m.type === "epic:result")).toBe(true);
	});

	test("resume → unrecoverable → fresh fallback succeeds, sets contextLost flag", async () => {
		analyzerCallsByBehavior = new Map();
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
});
