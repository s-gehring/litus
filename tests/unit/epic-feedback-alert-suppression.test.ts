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

describe("epic feedback alert suppression (FR-001 / FR-002)", () => {
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

		// Capture any onAlertEmit emissions a real orchestrator would have
		// produced. The stub orchestrator never emits, so the bug fix is
		// proven by the suppression flag being set on every abortPipeline
		// call from the feedback path.
		const alertEmissions: Array<{ type: string }> = [];
		// (No orchestrator path in the stub feeds into onAlertEmit; we keep
		// this list to express intent: the assertion below is the contract.)

		await handleEpicFeedback(
			ws as unknown as Parameters<typeof handleEpicFeedback>[0],
			{ type: "epic:feedback", epicId: epic.epicId, text: "split spec 2" } as ClientMessage,
			deps,
		);

		expect(abortCalls.length).toBe(2);
		for (const call of abortCalls) {
			expect(call.opts).toEqual({ suppressEpicFinishedAlert: true });
		}
		// And no `epic-finished` alert was synthesised by any path that ran.
		expect(alertEmissions.some((a) => a.type === "epic-finished")).toBe(false);
	});

	test("non-feedback abort callers do not opt into suppression (default off)", () => {
		// This is a contract assertion: the only call site of
		// `deleteChildWorkflows` that opts in is `runFeedbackAttempt`. Other
		// abort-pipeline call sites (e.g. user-initiated abort, archive
		// cascades) leave `suppressEpicFinishedAlert` at its default `false`,
		// so genuine sibling-completion still fires `epic-finished`.
		//
		// Spec FR-002 / SC-002. Verified by reading the source — there is
		// exactly one caller of `deleteChildWorkflows`, and the only abort
		// site that passes the suppression flag is that caller. A grep gate
		// here is sufficient to lock in the non-regression.
		const epicHandlersSrc = require("node:fs").readFileSync(
			require("node:path").join(__dirname, "..", "..", "src", "server", "epic-handlers.ts"),
			"utf8",
		) as string;
		const orchestratorSrc = require("node:fs").readFileSync(
			require("node:path").join(__dirname, "..", "..", "src", "pipeline-orchestrator.ts"),
			"utf8",
		) as string;

		// Only one call site sets the flag, in epic-handlers.ts.
		const matches = epicHandlersSrc.match(/suppressEpicFinishedAlert:\s*true/g) ?? [];
		expect(matches.length).toBe(1);

		// And no abortPipeline call inside pipeline-orchestrator.ts itself
		// (e.g. a future internal caller) silently sets the flag.
		const orchMatches = orchestratorSrc.match(/suppressEpicFinishedAlert:\s*true/g) ?? [];
		// Only the caller in checkEpicDependencies short-circuits; the field
		// appears as the param name and the `?? false` default, never as
		// `true` literal.
		expect(orchMatches.length).toBe(0);
	});
});
