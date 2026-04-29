import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import { getStepDefinitionsForKind } from "../../src/pipeline-steps";
import type { ClientMessage } from "../../src/protocol";
import type { Workflow } from "../../src/types";
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

function setup(workflow?: Partial<Workflow>, opts?: { submitResumeWithFeedbackResult?: unknown }) {
	const { mock: ws } = createMockWebSocket();
	const mockWs = ws as unknown as Parameters<typeof handleAnswer>[0];

	const wf = makeWorkflow(workflow);
	const calls: { method: string; args: unknown[] }[] = [];
	const rwfResult = opts?.submitResumeWithFeedbackResult ?? {
		ok: true,
		feedbackEntryId: "rwf-entry-1",
	};
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
		abortPipeline(...args: unknown[]) {
			calls.push({ method: "abortPipeline", args });
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
		submitResumeWithFeedback(...args: unknown[]) {
			calls.push({ method: "submitResumeWithFeedback", args });
			return rwfResult;
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

		test("quick-fix: rejects empty specification with kind-specific error", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleStart>[0];
			const { deps, sentMessages } = createMockHandlerDeps();

			await handleStart(
				mockWs,
				{
					type: "workflow:start",
					specification: "   ",
					targetRepository: "/mock/repo",
					workflowKind: "quick-fix",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(mockWs) ?? [];
			expect(
				msgs.some(
					(m) => m.type === "error" && m.message === "Quick Fix description must not be empty.",
				),
			).toBe(true);
		});

		test("quick-fix: rejects oversize specification", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleStart>[0];
			const { deps, sentMessages } = createMockHandlerDeps();

			await handleStart(
				mockWs,
				{
					type: "workflow:start",
					specification: "x".repeat(100_001),
					targetRepository: "/mock/repo",
					workflowKind: "quick-fix",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(mockWs) ?? [];
			expect(
				msgs.some((m) => m.type === "error" && m.message.includes("exceeds maximum length")),
			).toBe(true);
		});

		test("quick-fix: non-string specification surfaces 'is required' error (not 'must not be empty')", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleStart>[0];
			const { deps, sentMessages } = createMockHandlerDeps();

			await handleStart(
				mockWs,
				{
					type: "workflow:start",
					specification: undefined as unknown as string,
					targetRepository: "/mock/repo",
					workflowKind: "quick-fix",
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(mockWs) ?? [];
			expect(
				msgs.some((m) => m.type === "error" && m.message === "Quick Fix description is required"),
			).toBe(true);
		});

		test("quick-fix: success path forwards workflowKind to startPipeline", async () => {
			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleStart>[0];

			const startedWorkflow = makeWorkflow({ workflowKind: "quick-fix", status: "running" });
			const startPipelineCalls: unknown[][] = [];
			const mockOrch = {
				startPipeline: async (spec: string, repo: string, managed: unknown, opts: unknown) => {
					startPipelineCalls.push([spec, repo, managed, opts]);
					return startedWorkflow;
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
					specification: "Fix the thing",
					targetRepository: "/mock/repo",
					workflowKind: "quick-fix",
				} as ClientMessage,
				deps,
			);

			expect(startPipelineCalls).toHaveLength(1);
			expect(startPipelineCalls[0]?.[3]).toEqual({ workflowKind: "quick-fix" });
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
			expect(calls[0].method).toBe("abortPipeline");
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
			// able to put a stuck-in-error workflow into `aborted` so the managed-
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
			expect(calls[0].method).toBe("abortPipeline");
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
			const rejection = msgs.find((m) => m.type === "workflow:feedback:rejected");
			expect(rejection).toBeDefined();
			if (!rejection || rejection.type !== "workflow:feedback:rejected") return;
			expect(rejection.reason).toBe("workflow-not-paused");
			expect(rejection.workflowId).toBe(wf.id);
			expect(rejection.currentState).toEqual({
				status: wf.status,
				currentStepIndex: wf.currentStepIndex,
			});
		});

		test("rejects when current step is not merge-pr (and has no resumable session)", () => {
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
					(m) => m.type === "workflow:feedback:rejected" && m.reason === "step-not-resumable",
				),
			).toBe(true);
		});

		test("rejects when autoMode is not manual (and step has no resumable session)", () => {
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
					(m) => m.type === "workflow:feedback:rejected" && m.reason === "step-not-resumable",
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

		test("rejects empty feedback when current step is not merge-pr (no resumable session)", () => {
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
					(m) => m.type === "workflow:feedback:rejected" && m.reason === "step-not-resumable",
				),
			).toBe(true);
		});

		test("rejects empty feedback when autoMode is not manual (no resumable session)", () => {
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
					(m) => m.type === "workflow:feedback:rejected" && m.reason === "step-not-resumable",
				),
			).toBe(true);
		});
	});

	describe("handleFeedback — FR-016 errored fix-implement", () => {
		function quickFixSetup(status: Workflow["status"] = "error") {
			// Build a quick-fix workflow with the fix-implement step as current.
			const quickFixSteps: Workflow["steps"] = getStepDefinitionsForKind("quick-fix").map(
				(def) => ({
					name: def.name,
					displayName: def.displayName,
					status: "pending",
					prompt: def.prompt,
					sessionId: null,
					output: "",
					outputLog: [],
					error: null,
					startedAt: null,
					completedAt: null,
					pid: null,
					history: [],
				}),
			);
			const fixIdx = quickFixSteps.findIndex((s) => s.name === "fix-implement");
			quickFixSteps[fixIdx].status = "error";
			const s = setup({
				workflowKind: "quick-fix",
				steps: quickFixSteps,
				currentStepIndex: fixIdx,
				status,
			});
			// autoMode intentionally non-manual: FR-016 retry-with-context must work
			// regardless of autoMode.
			// biome-ignore lint/suspicious/noExplicitAny: partial mock save
			(s.deps.configStore.save as any)({ autoMode: "normal" });
			return s;
		}

		test("accepts non-empty feedback on errored fix-implement regardless of autoMode", () => {
			const { ws, deps, calls, wf } = quickFixSetup();

			handleFeedback(
				ws,
				{
					type: "workflow:feedback",
					workflowId: wf.id,
					text: "also update the tests",
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe("submitFeedback");
			expect(calls[0].args).toEqual([wf.id, "also update the tests"]);
		});

		test("rejects empty feedback with retry-specific message", () => {
			const { ws, deps, sentMessages, calls, wf } = quickFixSetup();

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
						m.message === "Feedback text is required to retry fix-implement with context",
				),
			).toBe(true);
		});

		test("rejects text over max length", () => {
			const { ws, deps, sentMessages, wf } = quickFixSetup();
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

		test("rejects when an in-flight feedback entry already exists", () => {
			const { ws, deps, sentMessages, wf } = quickFixSetup();
			wf.feedbackEntries = [
				{
					id: "in-flight-1",
					iteration: 1,
					text: "previous retry",
					submittedAt: new Date().toISOString(),
					submittedAtStepName: "fix-implement",
					outcome: null,
				},
			];

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

		test("does not accept non-error status on fix-implement (falls through to dispatch row 4)", () => {
			// A running quick-fix at fix-implement must NOT be treated as
			// feedback-eligible — only the error + fix-implement combo is FR-016.
			const { ws, deps, sentMessages, calls, wf } = quickFixSetup("running");

			handleFeedback(
				ws,
				{
					type: "workflow:feedback",
					workflowId: wf.id,
					text: "retry guidance",
				} as ClientMessage,
				deps,
			);

			expect(calls).toHaveLength(0);
			const msgs = sentMessages.get(ws) ?? [];
			expect(
				msgs.some(
					(m) => m.type === "workflow:feedback:rejected" && m.reason === "workflow-not-paused",
				),
			).toBe(true);
		});
	});

	describe("handleFeedback — dispatch precedence (FR-011, US3)", () => {
		test("T027: paused + merge-pr + manual + sessionId set still routes to merge-pr-iteration (row 1 wins over row 3)", () => {
			const s = setup({ status: "paused" });
			const mergeIdx = s.wf.steps.findIndex((st) => st.name === "merge-pr");
			s.wf.currentStepIndex = mergeIdx;
			s.wf.steps[mergeIdx].status = "paused";
			// Set a sessionId so the resume-with-feedback predicate WOULD match
			// if not for the merge-pr-iteration row taking precedence.
			s.wf.steps[mergeIdx].sessionId = "sess-merge-pr-active";
			// biome-ignore lint/suspicious/noExplicitAny: mock save
			(s.deps.configStore.save as any)({ autoMode: "manual" });

			handleFeedback(
				s.ws,
				{
					type: "workflow:feedback",
					workflowId: s.wf.id,
					text: "iteration text",
				} as ClientMessage,
				s.deps,
			);

			// Row 1 (existing manual-mode merge-PR iteration) MUST win — the
			// existing `submitFeedback` is called, not the new
			// `submitResumeWithFeedback`.
			expect(s.calls).toHaveLength(1);
			expect(s.calls[0].method).toBe("submitFeedback");
		});

		test("T028: error + fix-implement still routes to fix-implement-retry (row 2)", () => {
			const quickFixSteps: Workflow["steps"] = getStepDefinitionsForKind("quick-fix").map(
				(def) => ({
					name: def.name,
					displayName: def.displayName,
					status: "pending",
					prompt: def.prompt,
					sessionId: null,
					output: "",
					outputLog: [],
					error: null,
					startedAt: null,
					completedAt: null,
					pid: null,
					history: [],
				}),
			);
			const fixIdx = quickFixSteps.findIndex((st) => st.name === "fix-implement");
			quickFixSteps[fixIdx].status = "error";
			// Even with a sessionId set, the workflow is `error` not `paused`,
			// so row 3 cannot match — row 2 owns this case (FR-016).
			quickFixSteps[fixIdx].sessionId = "sess-fix-implement";
			const s = setup({
				workflowKind: "quick-fix",
				steps: quickFixSteps,
				currentStepIndex: fixIdx,
				status: "error",
			});
			// biome-ignore lint/suspicious/noExplicitAny: mock save
			(s.deps.configStore.save as any)({ autoMode: "normal" });

			handleFeedback(
				s.ws,
				{
					type: "workflow:feedback",
					workflowId: s.wf.id,
					text: "retry context",
				} as ClientMessage,
				s.deps,
			);

			expect(s.calls).toHaveLength(1);
			expect(s.calls[0].method).toBe("submitFeedback");
		});

		test("row 3 success: emits workflow:feedback:ok with kind and feedbackEntryId", () => {
			const s = setup({ status: "paused" });
			const implIdx = s.wf.steps.findIndex((st) => st.name === "implement");
			s.wf.currentStepIndex = implIdx;
			s.wf.steps[implIdx].status = "paused";
			s.wf.steps[implIdx].sessionId = "sess-rwf-active";
			// biome-ignore lint/suspicious/noExplicitAny: mock save
			(s.deps.configStore.save as any)({ autoMode: "normal" });

			handleFeedback(
				s.ws,
				{
					type: "workflow:feedback",
					workflowId: s.wf.id,
					text: "please refactor the parser",
				} as ClientMessage,
				s.deps,
			);

			expect(s.calls).toHaveLength(1);
			expect(s.calls[0].method).toBe("submitResumeWithFeedback");
			const msgs = s.sentMessages.get(s.ws) ?? [];
			const ok = msgs.find((m) => m.type === "workflow:feedback:ok");
			expect(ok).toBeDefined();
			if (!ok || ok.type !== "workflow:feedback:ok") return;
			expect(ok.kind).toBe("resume-with-feedback");
			expect(ok.workflowId).toBe(s.wf.id);
			expect(ok.feedbackEntryId).toBe("rwf-entry-1");
			expect(ok.warning).toBeUndefined();
		});

		test("row 3 sync spawn failure: emits workflow:feedback:ok with prompt-injection-failed warning", () => {
			const s = setup(
				{ status: "paused" },
				{
					submitResumeWithFeedbackResult: {
						ok: true,
						feedbackEntryId: "rwf-entry-warn",
						warning: "prompt-injection-failed",
						workflowStatusAfter: "error",
					},
				},
			);
			const implIdx = s.wf.steps.findIndex((st) => st.name === "implement");
			s.wf.currentStepIndex = implIdx;
			s.wf.steps[implIdx].status = "paused";
			s.wf.steps[implIdx].sessionId = "sess-rwf-fail";
			// biome-ignore lint/suspicious/noExplicitAny: mock save
			(s.deps.configStore.save as any)({ autoMode: "normal" });

			handleFeedback(
				s.ws,
				{
					type: "workflow:feedback",
					workflowId: s.wf.id,
					text: "x",
				} as ClientMessage,
				s.deps,
			);

			const msgs = s.sentMessages.get(s.ws) ?? [];
			const ok = msgs.find((m) => m.type === "workflow:feedback:ok");
			expect(ok).toBeDefined();
			if (!ok || ok.type !== "workflow:feedback:ok") return;
			expect(ok.kind).toBe("resume-with-feedback");
			expect(ok.feedbackEntryId).toBe("rwf-entry-warn");
			expect(ok.warning).toBe("prompt-injection-failed");
			expect(ok.workflowStatusAfter).toBe("error");
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
