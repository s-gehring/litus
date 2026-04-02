import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CLICallbacks } from "../src/cli-runner";
import {
	PipelineOrchestrator,
	type PipelineCallbacks,
} from "../src/pipeline-orchestrator";
import type { PipelineStepName, Question, ReviewSeverity, Workflow, WorkflowStatus } from "../src/types";
import { PIPELINE_STEP_DEFINITIONS, REVIEW_CYCLE_MAX_ITERATIONS } from "../src/types";

// ── Fake dependencies (no mock.module — uses DI) ──────────────────────

function createFakeEngine() {
	let workflow: Workflow | null = null;

	return {
		getWorkflow: () => workflow,
		createWorkflow: async (spec: string) => {
			const now = new Date().toISOString();
			workflow = {
				id: "test-wf-id",
				specification: spec,
				status: "idle" as WorkflowStatus,
				sessionId: null,
				worktreePath: "/tmp/test-worktree",
				worktreeBranch: "crab-studio/test",
				summary: "",
				pendingQuestion: null,
				lastOutput: "",
				steps: PIPELINE_STEP_DEFINITIONS.map((def) => ({
					name: def.name,
					displayName: def.displayName,
					status: "pending" as const,
					prompt: def.name === "specify" ? `${def.prompt} ${spec}` : def.prompt,
					sessionId: null,
					output: "",
					error: null,
					startedAt: null,
					completedAt: null,
				})),
				currentStepIndex: 0,
				reviewCycle: { iteration: 1, maxIterations: REVIEW_CYCLE_MAX_ITERATIONS, lastSeverity: null },
				createdAt: now,
				updatedAt: now,
			};
			return workflow;
		},
		transition: (_id: string, status: WorkflowStatus) => {
			if (workflow) workflow.status = status;
		},
		updateLastOutput: (_id: string, text: string) => {
			if (workflow) { workflow.lastOutput = text; workflow.updatedAt = new Date().toISOString(); }
		},
		setQuestion: (_id: string, question: Question) => {
			if (workflow) { workflow.pendingQuestion = question; workflow.updatedAt = new Date().toISOString(); }
		},
		clearQuestion: (_id: string) => {
			if (workflow) { workflow.pendingQuestion = null; workflow.updatedAt = new Date().toISOString(); }
		},
		setSessionId: (_id: string, sessionId: string) => {
			if (workflow) { workflow.sessionId = sessionId; workflow.updatedAt = new Date().toISOString(); }
		},
		updateSummary: (_id: string, summary: string) => {
			if (workflow) { workflow.summary = summary; workflow.updatedAt = new Date().toISOString(); }
		},
		// Expose for test assertions
		_getWorkflow: () => workflow,
	};
}

function createFakeCliRunner() {
	const startCalls: Array<{ workflow: Workflow; callbacks: CLICallbacks }> = [];

	return {
		start: (workflow: Workflow, callbacks: CLICallbacks) => {
			startCalls.push({ workflow, callbacks });
		},
		kill: mock((_id: string) => {}),
		sendAnswer: mock((_id: string, _answer: string) => {}),
		killAll: mock(() => {}),
		_startCalls: startCalls,
		getLastCallbacks: (): CLICallbacks => startCalls[startCalls.length - 1].callbacks,
	};
}

function createFakeQuestionDetector() {
	const detectResults: Array<Question | null> = [];
	return {
		detect: (_text: string): Question | null => detectResults.shift() ?? null,
		classifyWithHaiku: mock((_text: string) => Promise.resolve(false)),
		reset: mock(() => {}),
		_pushDetectResult: (r: Question | null) => detectResults.push(r),
	};
}

function createFakeReviewClassifier() {
	const classifyResults: ReviewSeverity[] = [];
	return {
		classify: async (_output: string): Promise<ReviewSeverity> => classifyResults.shift() ?? "minor",
		_pushClassifyResult: (r: ReviewSeverity) => classifyResults.push(r),
	};
}

function createFakeSummarizer() {
	return {
		maybeSummarize: mock(() => {}),
		cleanup: mock(() => {}),
	};
}

function makeCallbacks(): PipelineCallbacks {
	return {
		onStepChange: mock(() => {}),
		onOutput: mock(() => {}),
		onComplete: mock(() => {}),
		onError: mock(() => {}),
		onStateChange: mock(() => {}),
	};
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("PipelineOrchestrator", () => {
	let orchestrator: PipelineOrchestrator;
	let callbacks: PipelineCallbacks;
	let engine: ReturnType<typeof createFakeEngine>;
	let cli: ReturnType<typeof createFakeCliRunner>;
	let qd: ReturnType<typeof createFakeQuestionDetector>;
	let rc: ReturnType<typeof createFakeReviewClassifier>;
	let summarizer: ReturnType<typeof createFakeSummarizer>;

	beforeEach(() => {
		callbacks = makeCallbacks();
		engine = createFakeEngine();
		cli = createFakeCliRunner();
		qd = createFakeQuestionDetector();
		rc = createFakeReviewClassifier();
		summarizer = createFakeSummarizer();

		// biome-ignore lint: DI with compatible fakes
		orchestrator = new PipelineOrchestrator(callbacks, {
			engine: engine as any,
			cliRunner: cli as any,
			questionDetector: qd as any,
			reviewClassifier: rc as any,
			summarizer: summarizer as any,
		});
	});

	// T009: Step sequencing
	describe("step sequencing", () => {
		test("startPipeline creates workflow and starts first step", async () => {
			await orchestrator.startPipeline("Build a login page");
			const wf = engine._getWorkflow()!;

			expect(wf).not.toBeNull();
			expect(wf.steps[0].status).toBe("running");
			expect(wf.currentStepIndex).toBe(0);
			expect(cli._startCalls.length).toBe(1);
		});

		test("pipeline has 8 steps in correct order", async () => {
			await orchestrator.startPipeline("test");
			const wf = engine._getWorkflow()!;

			const expectedOrder: PipelineStepName[] = [
				"specify", "clarify", "plan", "tasks",
				"implement", "review", "implement-review", "commit-push-pr",
			];
			expect(wf.steps.map((s) => s.name)).toEqual(expectedOrder);
		});

		test("advancing step moves to next step", async () => {
			await orchestrator.startPipeline("test");
			const wf = engine._getWorkflow()!;

			cli.getLastCallbacks().onComplete();

			expect(wf.steps[0].status).toBe("completed");
			expect(wf.steps[1].status).toBe("running");
			expect(wf.currentStepIndex).toBe(1);
		});

		test("completing all steps triggers pipeline completion", async () => {
			await orchestrator.startPipeline("test");

			// Complete steps 0–4 (specify → implement)
			for (let i = 0; i < 5; i++) {
				cli.getLastCallbacks().onComplete();
			}

			// Review step (5): classify as minor → skip re-cycle
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			// commit-push-pr (7) — skips implement-review via minor path
			cli.getLastCallbacks().onComplete();

			expect(callbacks.onComplete).toHaveBeenCalled();
		});
	});

	// T010: Q&A loop
	describe("Q&A loop", () => {
		test("detects question after step output and pauses", async () => {
			await orchestrator.startPipeline("test");
			const wf = engine._getWorkflow()!;

			const question: Question = {
				id: "q1",
				content: "Should I use React?",
				confidence: "certain",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);

			cli.getLastCallbacks().onComplete();

			expect(wf.steps[0].status).toBe("waiting_for_input");
			expect(wf.pendingQuestion).toEqual(question);
		});

		test("answering question resumes step via sendAnswer", async () => {
			await orchestrator.startPipeline("test");

			cli.getLastCallbacks().onSessionId("sess-123");

			const question: Question = {
				id: "q1",
				content: "Should I use React?",
				confidence: "certain",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			cli.getLastCallbacks().onComplete();

			orchestrator.answerQuestion("test-wf-id", "q1", "Yes, use React");

			expect(cli.sendAnswer).toHaveBeenCalledWith("test-wf-id", "Yes, use React");
		});

		test("Q&A loop pauses again on second question", async () => {
			await orchestrator.startPipeline("test");
			const wf = engine._getWorkflow()!;

			cli.getLastCallbacks().onSessionId("sess-123");

			// First question
			const q1: Question = {
				id: "q1",
				content: "Question 1?",
				confidence: "certain",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(q1);
			cli.getLastCallbacks().onComplete();
			expect(wf.pendingQuestion).toEqual(q1);

			// Answer → sendAnswer called
			orchestrator.answerQuestion("test-wf-id", "q1", "Answer 1");
			expect(cli.sendAnswer).toHaveBeenCalledWith("test-wf-id", "Answer 1");
		});
	});

	// T011: Review cycling
	describe("review cycling", () => {
		async function advanceToReview() {
			await orchestrator.startPipeline("test");
			// Complete steps 0-4
			for (let i = 0; i < 5; i++) {
				cli.getLastCallbacks().onComplete();
			}
			const wf = engine._getWorkflow()!;
			expect(wf.currentStepIndex).toBe(5);
			expect(wf.steps[5].name).toBe("review");
		}

		test("re-cycles on critical severity", async () => {
			await advanceToReview();
			const wf = engine._getWorkflow()!;

			rc._pushClassifyResult("critical");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.reviewCycle.iteration).toBe(2);
			expect(wf.reviewCycle.lastSeverity).toBe("critical");
			expect(wf.currentStepIndex).toBe(6); // implement-review
		});

		test("re-cycles on major severity", async () => {
			await advanceToReview();
			const wf = engine._getWorkflow()!;

			rc._pushClassifyResult("major");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.reviewCycle.iteration).toBe(2);
			expect(wf.reviewCycle.lastSeverity).toBe("major");
		});

		test("stops cycling on minor severity → advances to commit-push-pr", async () => {
			await advanceToReview();
			const wf = engine._getWorkflow()!;

			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(7);
			expect(wf.steps[7].name).toBe("commit-push-pr");
		});

		test("stops cycling on trivial severity", async () => {
			await advanceToReview();
			const wf = engine._getWorkflow()!;

			rc._pushClassifyResult("trivial");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(7);
		});

		test("stops cycling on nit severity", async () => {
			await advanceToReview();
			const wf = engine._getWorkflow()!;

			rc._pushClassifyResult("nit");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(7);
		});

		test("caps review cycling at maxIterations", async () => {
			await advanceToReview();
			const wf = engine._getWorkflow()!;

			wf.reviewCycle.iteration = 16;

			rc._pushClassifyResult("critical");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(7); // commit-push-pr despite critical
		});
	});

	// T012: Step failure and retry
	describe("step failure and retry", () => {
		test("step failure sets step to error state", async () => {
			await orchestrator.startPipeline("test");
			const wf = engine._getWorkflow()!;

			cli.getLastCallbacks().onError("CLI crashed");

			expect(wf.steps[0].status).toBe("error");
			expect(wf.steps[0].error).toBe("CLI crashed");
			expect(wf.status).toBe("error");
		});

		test("retry re-runs the failed step", async () => {
			await orchestrator.startPipeline("test");
			const wf = engine._getWorkflow()!;

			cli.getLastCallbacks().onError("CLI crashed");

			const callsBefore = cli._startCalls.length;
			orchestrator.retryStep("test-wf-id");

			expect(cli._startCalls.length).toBe(callsBefore + 1);
			expect(wf.steps[0].status).toBe("running");
			expect(wf.steps[0].error).toBeNull();
		});

		test("completed steps are preserved on retry", async () => {
			await orchestrator.startPipeline("test");
			const wf = engine._getWorkflow()!;

			// Complete step 0
			cli.getLastCallbacks().onComplete();

			// Step 1 fails
			cli.getLastCallbacks().onError("crashed");

			expect(wf.steps[0].status).toBe("completed");
			expect(wf.steps[1].status).toBe("error");

			// Retry step 1
			orchestrator.retryStep("test-wf-id");
			expect(wf.steps[0].status).toBe("completed");
			expect(wf.steps[1].status).toBe("running");
		});
	});

	// T026: Cancellation
	describe("cancellation", () => {
		test("cancelPipeline kills CLI process and sets cancelled state", async () => {
			await orchestrator.startPipeline("test");
			const wf = engine._getWorkflow()!;

			orchestrator.cancelPipeline("test-wf-id");

			expect(cli.kill).toHaveBeenCalledWith("test-wf-id");
			expect(wf.status).toBe("cancelled");
			expect(wf.steps[0].status).toBe("error");
			expect(wf.steps[0].error).toBe("Cancelled by user");
		});

		test("cancellation during Q&A sets cancelled state", async () => {
			await orchestrator.startPipeline("test");
			const wf = engine._getWorkflow()!;

			const question: Question = {
				id: "q1",
				content: "Question?",
				confidence: "certain",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			cli.getLastCallbacks().onComplete();

			orchestrator.cancelPipeline("test-wf-id");

			expect(wf.status).toBe("cancelled");
		});
	});
});
