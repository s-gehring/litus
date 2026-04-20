import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
	handleFeedback,
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
		submitFeedback(...args: unknown[]) {
			calls.push({ method: "submitFeedback", args });
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
			expect(msgs.some((m) => m.type === "error" && m.message === "something went wrong")).toBe(
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

		test("aborts an errored workflow (user's escape hatch from error)", () => {
			// Error is no longer terminal for refcount purposes — the user must be
			// able to put a stuck-in-error workflow into `cancelled` so the managed-
			// repo refcount actually drops. Before this was allowed, the only way
			// out was a full purge.
			const { ws, deps, calls, wf, orchestrators } = setup({ status: "error" });

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

	describe("handleFeedback", () => {
		function feedbackSetup(overrides?: {
			inFlight?: boolean;
			step?: string;
			status?: string;
			autoMode?: string;
		}) {
			const s = setup({
				status: (overrides?.status ?? "paused") as Workflow["status"],
			});
			const step = overrides?.step ?? "merge-pr";
			const stepIdx = s.wf.steps.findIndex((st) => st.name === step);
			if (stepIdx >= 0) {
				s.wf.currentStepIndex = stepIdx;
				s.wf.steps[stepIdx].status = "paused";
			}
			if (overrides?.inFlight) {
				s.wf.feedbackEntries = [
					{
						id: "in-flight-1",
						iteration: 1,
						text: "in flight",
						submittedAt: new Date().toISOString(),
						submittedAtStepName: "merge-pr",
						outcome: null,
					},
				];
			}
			const autoMode = (overrides?.autoMode ?? "manual") as "manual" | "normal" | "full-auto";
			// biome-ignore lint/suspicious/noExplicitAny: mock config save accepts partial
			(s.deps.configStore.save as any)({ autoMode });
			return s;
		}

		test("accepts non-empty feedback on manual merge-pr pause", () => {
			const { ws, deps, calls, wf } = feedbackSetup();

			handleFeedback(
				ws,
				{
					type: "workflow:feedback",
					workflowId: wf.id,
					text: "  rename x to count  ",
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe("submitFeedback");
			expect(calls[0].args).toEqual([wf.id, "  rename x to count  "]);
		});

		test("empty text resumes the workflow (FR-014)", () => {
			const { ws, deps, calls, wf } = feedbackSetup();

			handleFeedback(
				ws,
				{
					type: "workflow:feedback",
					workflowId: wf.id,
					text: "   ",
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe("resume");
		});

		test("rejects unknown workflow", () => {
			const { ws, deps, sentMessages } = feedbackSetup();

			handleFeedback(
				ws,
				{
					type: "workflow:feedback",
					workflowId: "nonexistent",
					text: "hi",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(msgs.some((m) => m.type === "error" && m.message === "Workflow not found")).toBe(true);
		});

		test("rejects text over max length", () => {
			const { ws, deps, sentMessages, wf } = feedbackSetup();
			const oversize = "x".repeat(100_001);

			handleFeedback(
				ws,
				{
					type: "workflow:feedback",
					workflowId: wf.id,
					text: oversize,
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(
				msgs.some((m) => m.type === "error" && m.message.includes("exceeds maximum length")),
			).toBe(true);
		});

		test("rejects when workflow status is not paused", () => {
			const { ws, deps, sentMessages, wf } = feedbackSetup({ status: "running" });

			handleFeedback(
				ws,
				{
					type: "workflow:feedback",
					workflowId: wf.id,
					text: "anything",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(
				msgs.some(
					(m) =>
						m.type === "error" &&
						m.message === "Workflow is not paused at a feedback-eligible step",
				),
			).toBe(true);
		});

		test("rejects when current step is not merge-pr", () => {
			const { ws, deps, sentMessages, wf } = feedbackSetup({ step: "implement" });

			handleFeedback(
				ws,
				{
					type: "workflow:feedback",
					workflowId: wf.id,
					text: "anything",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(
				msgs.some(
					(m) =>
						m.type === "error" &&
						m.message === "Workflow is not paused at a feedback-eligible step",
				),
			).toBe(true);
		});

		test("rejects when autoMode is not manual", () => {
			const { ws, deps, sentMessages, wf } = feedbackSetup({ autoMode: "normal" });

			handleFeedback(
				ws,
				{
					type: "workflow:feedback",
					workflowId: wf.id,
					text: "anything",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(
				msgs.some(
					(m) =>
						m.type === "error" &&
						m.message === "Workflow is not paused at a feedback-eligible step",
				),
			).toBe(true);
		});

		test("rejects when an in-flight feedback entry exists (FR-016)", () => {
			const { ws, deps, sentMessages, wf } = feedbackSetup({ inFlight: true });

			handleFeedback(
				ws,
				{
					type: "workflow:feedback",
					workflowId: wf.id,
					text: "another",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(
				msgs.some(
					(m) => m.type === "error" && m.message === "A feedback iteration is already in progress",
				),
			).toBe(true);
		});

		test("rejects empty feedback when current step is not merge-pr", () => {
			const { ws, deps, sentMessages, calls, wf } = feedbackSetup({ step: "implement" });

			handleFeedback(
				ws,
				{
					type: "workflow:feedback",
					workflowId: wf.id,
					text: "   ",
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(0);
			const msgs = sentMessages.get(ws) ?? [];
			expect(
				msgs.some(
					(m) =>
						m.type === "error" &&
						m.message === "Workflow is not paused at a feedback-eligible step",
				),
			).toBe(true);
		});

		test("rejects empty feedback when autoMode is not manual", () => {
			const { ws, deps, sentMessages, calls, wf } = feedbackSetup({ autoMode: "normal" });

			handleFeedback(
				ws,
				{
					type: "workflow:feedback",
					workflowId: wf.id,
					text: "",
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(0);
			const msgs = sentMessages.get(ws) ?? [];
			expect(
				msgs.some(
					(m) =>
						m.type === "error" &&
						m.message === "Workflow is not paused at a feedback-eligible step",
				),
			).toBe(true);
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

	describe("error logging in catch blocks", () => {
		let errorSpy: ReturnType<typeof spyOn>;

		beforeEach(() => {
			errorSpy = spyOn(console, "error").mockImplementation(() => {});
		});

		afterEach(() => {
			errorSpy.mockRestore();
		});

		test("handleStart logs error when startPipeline throws", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleStart>[0];

			const mockOrch = {
				startPipeline: async () => {
					throw new Error("spawn failed");
				},
			} as unknown as PipelineOrchestrator;

			const { deps } = createMockHandlerDeps({
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

			expect(errorSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining("[ws] workflow:start failed:"),
				expect.anything(),
			);
		});

		test("handleStartExisting logs error when startPipelineFromWorkflow throws", () => {
			const wf = makeWorkflow({ status: "idle" });
			const mockOrch = {
				getEngine() {
					return {
						getWorkflow() {
							return wf;
						},
					};
				},
				startPipelineFromWorkflow() {
					throw new Error("engine failure");
				},
			} as unknown as PipelineOrchestrator;

			const orchestrators = new Map<string, PipelineOrchestrator>();
			orchestrators.set(wf.id, mockOrch);

			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleStartExisting>[0];
			const { deps } = createMockHandlerDeps({ orchestrators });

			handleStartExisting(
				mockWs,
				{
					type: "workflow:start-existing",
					workflowId: wf.id,
				} as ClientMessage,
				deps,
			);

			expect(errorSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining("[ws] workflow:start-existing failed:"),
				expect.anything(),
			);
		});
	});

	describe("withOrchestrator validation logging", () => {
		let warnSpy: ReturnType<typeof spyOn>;

		beforeEach(() => {
			warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		});

		afterEach(() => {
			warnSpy.mockRestore();
		});

		test("logs warning when workflowId is missing", () => {
			const { ws, deps } = setup();

			handleAnswer(
				ws,
				{
					type: "workflow:answer",
					questionId: "q1",
					answer: "yes",
				} as ClientMessage,
				deps,
			);

			expect(warnSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining("[ws] Missing workflowId"),
			);
		});

		test("logs warning when workflow is not found", () => {
			const { ws, deps } = setup();

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

			expect(warnSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining("[ws] Workflow not found: nonexistent"),
			);
		});
	});
});
