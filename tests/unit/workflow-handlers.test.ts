import { describe, expect, mock, test } from "bun:test";
import type { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type { ClientMessage, Workflow } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

// ── Module mocks ──────────────────────────────────────────────────────

let mockValidationResult: { valid: boolean; error?: string; effectivePath: string } = {
	valid: true,
	effectivePath: "/mock/repo",
};

mock.module("../../src/target-repo-validator", () => ({
	validateTargetRepository: async () => mockValidationResult,
}));

import {
	handleAbort,
	handleAnswer,
	handleForceStart,
	handlePause,
	handleResume,
	handleRetry,
	handleSkip,
	handleStart,
	handleStartExisting,
} from "../../src/server/workflow-handlers";

function setup(workflow?: Partial<Workflow>) {
	const { mock: ws } = createMockWebSocket();
	const mockWs = ws as unknown as Parameters<typeof handleAnswer>[0];

	const wf = makeWorkflow(workflow);
	const calls: { method: string; args: unknown[] }[] = [];
	const mockOrch = {
		getEngine() {
			return {
				getWorkflow() {
					return wf;
				},
				setWorkflow() {},
			};
		},
		answerQuestion(...args: unknown[]) {
			calls.push({ method: "answerQuestion", args });
		},
		skipQuestion(...args: unknown[]) {
			calls.push({ method: "skipQuestion", args });
		},
		pause(...args: unknown[]) {
			calls.push({ method: "pause", args });
		},
		resume(...args: unknown[]) {
			calls.push({ method: "resume", args });
		},
		cancelPipeline(...args: unknown[]) {
			calls.push({ method: "cancelPipeline", args });
		},
		retryStep(...args: unknown[]) {
			calls.push({ method: "retryStep", args });
		},
		startPipelineFromWorkflow(...args: unknown[]) {
			calls.push({ method: "startPipelineFromWorkflow", args });
		},
	} as unknown as PipelineOrchestrator;

	const orchestrators = new Map<string, PipelineOrchestrator>();
	orchestrators.set(wf.id, mockOrch);

	const { deps, sentMessages } = createMockHandlerDeps({ orchestrators });

	return { ws: mockWs, deps, sentMessages, wf, calls, orchestrators };
}

describe("workflow-handlers", () => {
	describe("handleStart", () => {
		test("creates and broadcasts a new workflow", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleStart>[0];

			const startedWorkflow = makeWorkflow({ status: "running" });
			const startPipelineCalls: unknown[][] = [];
			const mockOrch = {
				startPipeline: async (spec: string, repo: string) => {
					startPipelineCalls.push([spec, repo]);
					return startedWorkflow;
				},
			} as unknown as PipelineOrchestrator;

			const { deps, broadcastedMessages } = createMockHandlerDeps({
				createOrchestrator: () => mockOrch,
			});

			mockValidationResult = { valid: true, effectivePath: "/mock/repo" };

			await handleStart(
				mockWs,
				{
					type: "workflow:start",
					specification: "Build a feature",
					targetRepository: "/mock/repo",
				} as ClientMessage,
				deps,
			);

			expect(startPipelineCalls).toHaveLength(1);
			expect(startPipelineCalls[0]).toEqual(["Build a feature", "/mock/repo"]);
			expect(deps.orchestrators.has(startedWorkflow.id)).toBe(true);
			expect(broadcastedMessages.some((m) => m.type === "workflow:created")).toBe(true);
		});

		test("rejects empty specification", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleStart>[0];
			const { deps, sentMessages } = createMockHandlerDeps();

			await handleStart(
				mockWs,
				{
					type: "workflow:start",
					specification: "  ",
					targetRepository: "/mock/repo",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(mockWs) ?? [];
			expect(
				msgs.some((m) => m.type === "error" && m.message === "Specification must be non-empty"),
			).toBe(true);
		});

		test("sends descriptive error when startPipeline throws a non-Error", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleStart>[0];

			const mockOrch = {
				startPipeline: async () => {
					throw "something went wrong";
				},
			} as unknown as PipelineOrchestrator;

			const { deps, sentMessages } = createMockHandlerDeps({
				createOrchestrator: () => mockOrch,
			});

			mockValidationResult = { valid: true, effectivePath: "/mock/repo" };

			await handleStart(
				mockWs,
				{
					type: "workflow:start",
					specification: "Build a feature",
					targetRepository: "/mock/repo",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(mockWs) ?? [];
			expect(msgs.some((m) => m.type === "error" && m.message === "Failed to start workflow")).toBe(
				true,
			);
		});

		test("sends Error.message when startPipeline throws an Error", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleStart>[0];

			const mockOrch = {
				startPipeline: async () => {
					throw new Error("Disk full");
				},
			} as unknown as PipelineOrchestrator;

			const { deps, sentMessages } = createMockHandlerDeps({
				createOrchestrator: () => mockOrch,
			});

			mockValidationResult = { valid: true, effectivePath: "/mock/repo" };

			await handleStart(
				mockWs,
				{
					type: "workflow:start",
					specification: "Build a feature",
					targetRepository: "/mock/repo",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(mockWs) ?? [];
			expect(msgs.some((m) => m.type === "error" && m.message === "Disk full")).toBe(true);
		});

		test("rejects invalid target repository", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleStart>[0];
			const { deps, sentMessages } = createMockHandlerDeps();

			mockValidationResult = { valid: false, error: "Not a git repo", effectivePath: "/bad" };

			await handleStart(
				mockWs,
				{
					type: "workflow:start",
					specification: "Build a feature",
					targetRepository: "/bad",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(mockWs) ?? [];
			expect(msgs.some((m) => m.type === "error" && m.message === "Not a git repo")).toBe(true);
		});
	});

	describe("withOrchestrator (missing workflowId)", () => {
		test("sends error when workflowId is missing from message", () => {
			const { ws, deps, sentMessages } = setup();

			handleAnswer(
				ws,
				{
					type: "workflow:answer",
					questionId: "q1",
					answer: "yes",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(msgs.some((m) => m.type === "error" && m.message === "Missing workflowId")).toBe(true);
		});
	});

	describe("handleAnswer", () => {
		test("answers a pending question", () => {
			const { ws, deps, calls, wf } = setup({
				status: "waiting_for_input",
				pendingQuestion: { id: "q1", content: "What?", detectedAt: new Date().toISOString() },
			});

			handleAnswer(
				ws,
				{
					type: "workflow:answer",
					workflowId: wf.id,
					questionId: "q1",
					answer: "yes",
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe("answerQuestion");
			expect(calls[0].args).toEqual([wf.id, "q1", "yes"]);
		});

		test("rejects empty answer", () => {
			const { ws, deps, sentMessages, wf } = setup({
				status: "waiting_for_input",
				pendingQuestion: { id: "q1", content: "What?", detectedAt: new Date().toISOString() },
			});

			handleAnswer(
				ws,
				{
					type: "workflow:answer",
					workflowId: wf.id,
					questionId: "q1",
					answer: "  ",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(msgs.some((m) => m.type === "error" && m.message === "Answer must be non-empty")).toBe(
				true,
			);
		});

		test("rejects wrong question ID", () => {
			const { ws, deps, sentMessages, wf } = setup({
				status: "waiting_for_input",
				pendingQuestion: { id: "q1", content: "What?", detectedAt: new Date().toISOString() },
			});

			handleAnswer(
				ws,
				{
					type: "workflow:answer",
					workflowId: wf.id,
					questionId: "q-wrong",
					answer: "yes",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(
				msgs.some(
					(m) => m.type === "error" && m.message === "Question not found or already answered",
				),
			).toBe(true);
		});

		test("rejects unknown workflow", () => {
			const { ws, deps, sentMessages } = setup();

			handleAnswer(
				ws,
				{
					type: "workflow:answer",
					workflowId: "nonexistent",
					questionId: "q1",
					answer: "yes",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(msgs.some((m) => m.type === "error" && m.message === "Workflow not found")).toBe(true);
		});
	});

	describe("handleSkip", () => {
		test("skips a pending question", () => {
			const { ws, deps, calls, wf } = setup({
				status: "waiting_for_input",
				pendingQuestion: { id: "q1", content: "What?", detectedAt: new Date().toISOString() },
			});

			handleSkip(
				ws,
				{
					type: "workflow:skip",
					workflowId: wf.id,
					questionId: "q1",
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe("skipQuestion");
		});
	});

	describe("handlePause", () => {
		test("pauses a running workflow", () => {
			const { ws, deps, calls, wf } = setup({ status: "running" });

			handlePause(
				ws,
				{
					type: "workflow:pause",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe("pause");
		});

		test("ignores non-running workflow", () => {
			const { ws, deps, calls, wf } = setup({ status: "paused" });

			handlePause(
				ws,
				{
					type: "workflow:pause",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(0);
		});
	});

	describe("handleResume", () => {
		test("resumes a paused workflow", () => {
			const { ws, deps, calls, wf } = setup({ status: "paused" });

			handleResume(
				ws,
				{
					type: "workflow:resume",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe("resume");
		});

		test("ignores non-paused workflow", () => {
			const { ws, deps, calls, wf } = setup({ status: "running" });

			handleResume(
				ws,
				{
					type: "workflow:resume",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(0);
		});
	});

	describe("handleAbort", () => {
		test("aborts a paused workflow", () => {
			const { ws, deps, calls, wf, orchestrators } = setup({ status: "paused" });

			handleAbort(
				ws,
				{
					type: "workflow:abort",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe("cancelPipeline");
			expect(orchestrators.has(wf.id)).toBe(false);
		});

		test("ignores running workflow", () => {
			const { ws, deps, calls, wf } = setup({ status: "running" });

			handleAbort(
				ws,
				{
					type: "workflow:abort",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(0);
		});
	});

	describe("handleRetry", () => {
		test("retries an errored workflow", () => {
			const { ws, deps, calls, wf } = setup({ status: "error" });

			handleRetry(
				ws,
				{
					type: "workflow:retry",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe("retryStep");
		});

		test("rejects non-error workflow", () => {
			const { ws, deps, sentMessages, wf } = setup({ status: "running" });

			handleRetry(
				ws,
				{
					type: "workflow:retry",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(msgs.some((m) => m.type === "error" && m.message === "No failed step to retry")).toBe(
				true,
			);
		});
	});

	describe("handleStartExisting", () => {
		test("starts an idle workflow", () => {
			const { ws, deps, calls, wf } = setup({ status: "idle" });

			handleStartExisting(
				ws,
				{
					type: "workflow:start-existing",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe("startPipelineFromWorkflow");
		});

		test("rejects non-idle workflow", () => {
			const { ws, deps, sentMessages, wf } = setup({ status: "running" });

			handleStartExisting(
				ws,
				{
					type: "workflow:start-existing",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(msgs.some((m) => m.type === "error" && m.message === "Workflow is not idle")).toBe(
				true,
			);
		});
	});

	describe("handleForceStart", () => {
		test("force-starts a waiting workflow", () => {
			const { ws, deps, calls, wf } = setup({ status: "waiting_for_dependencies" });

			handleForceStart(
				ws,
				{
					type: "workflow:force-start",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe("startPipelineFromWorkflow");
			expect(wf.epicDependencyStatus).toBe("overridden");
		});

		test("rejects non-waiting workflow", () => {
			const { ws, deps, sentMessages, wf } = setup({ status: "running" });

			handleForceStart(
				ws,
				{
					type: "workflow:force-start",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(
				msgs.some(
					(m) => m.type === "error" && m.message === "Workflow is not waiting for dependencies",
				),
			).toBe(true);
		});
	});
});
