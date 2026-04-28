import { describe, expect, mock, test } from "bun:test";
import type { ClientMessage } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { makePersistedEpic } from "../test-infra/factories";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

// Stub the analyzer + workflow factory so runFeedbackAttempt can complete
// without spawning real agents. The behavior of analyzeEpic is irrelevant to
// alert suppression; only the abort cascade triggered before analysis is.
mock.module("../../src/target-repo-validator", () => ({
	validateTargetRepository: async () => ({ valid: true, effectivePath: "/mock/repo" }),
}));

mock.module("../../src/epic-analyzer", () => ({
	UnrecoverableSessionError: class extends Error {
		constructor(msg: string) {
			super(msg);
			this.name = "UnrecoverableSessionError";
		}
	},
	analyzeEpic: async (
		_desc: string,
		_repo: string,
		_ref: unknown,
		_timeout: unknown,
		cbs: { onSessionId?: (sid: string) => void } | undefined,
	) => {
		cbs?.onSessionId?.("sess-after");
		return {
			title: "Refined",
			specs: [{ id: "s1", title: "Spec", description: "do", dependencies: [] }],
			summary: "refined",
			infeasibleNotes: null,
		};
	},
}));

mock.module("../../src/workflow-engine", () => ({
	createEpicWorkflows: async () => ({
		workflows: [makeWorkflow({ id: "wf-after-feedback" })],
		epicId: "ignored",
	}),
}));

import { handleEpicFeedback } from "../../src/server/epic-handlers";

describe("epic feedback alert suppression — call-site contract (FR-001)", () => {
	test("aborting all-terminal child workflows during feedback opts into suppression", async () => {
		const { mock: ws } = createMockWebSocket();
		const { deps } = createMockHandlerDeps();
		const epic = makePersistedEpic({
			epicId: `alert-suppress-${Date.now()}`,
			status: "completed",
			workflowIds: ["wf-1", "wf-2"],
			decompositionSessionId: "initial-sess",
		});
		await deps.sharedEpicStore.save(epic);
		await deps.sharedStore.save(
			makeWorkflow({
				id: "wf-1",
				epicId: epic.epicId,
				targetRepository: "/mock/repo",
				hasEverStarted: false,
			}),
		);
		await deps.sharedStore.save(
			makeWorkflow({
				id: "wf-2",
				epicId: epic.epicId,
				targetRepository: "/mock/repo",
				hasEverStarted: false,
			}),
		);
		deps.sharedAuditLogger = {
			logFeedbackSubmitted() {},
			logDecompositionResumed() {},
		} as unknown as typeof deps.sharedAuditLogger;

		// Stub orchestrators that record the option passed to abortPipeline.
		const abortCalls: Array<{ workflowId: string; opts: unknown }> = [];
		const makeStubOrch = () =>
			({
				getEngine: () => ({ setWorkflow() {}, getWorkflow: () => null }),
				startPipelineFromWorkflow() {},
				abortPipeline(workflowId: string, opts?: unknown) {
					abortCalls.push({ workflowId, opts });
				},
			}) as unknown as ReturnType<typeof deps.createOrchestrator>;
		deps.orchestrators.set("wf-1", makeStubOrch());
		deps.orchestrators.set("wf-2", makeStubOrch());
		deps.createOrchestrator = makeStubOrch;

		await handleEpicFeedback(
			ws as unknown as Parameters<typeof handleEpicFeedback>[0],
			{ type: "epic:feedback", epicId: epic.epicId, text: "split spec 2" } as ClientMessage,
			deps,
		);

		expect(abortCalls.length).toBe(2);
		for (const call of abortCalls) {
			expect(call.opts).toEqual({ suppressEpicFinishedAlert: true });
		}
	});
});
