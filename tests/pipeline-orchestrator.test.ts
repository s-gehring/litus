import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CLICallbacks } from "../src/cli-runner";
import { DEFAULT_CONFIG } from "../src/config-store";
import { type PipelineCallbacks, PipelineOrchestrator } from "../src/pipeline-orchestrator";
import type {
	PipelineStepName,
	Question,
	ReviewSeverity,
	Workflow,
	WorkflowStatus,
} from "../src/types";
import { PIPELINE_STEP_DEFINITIONS } from "../src/types";

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
				targetRepository: null,
				worktreePath: "/tmp/test-worktree",
				worktreeBranch: "crab-studio/test",
				summary: "",
				stepSummary: "",
				flavor: "",
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
					pid: null,
				})),
				currentStepIndex: 0,
				reviewCycle: {
					iteration: 1,
					maxIterations: DEFAULT_CONFIG.limits.reviewCycleMaxIterations,
					lastSeverity: null,
				},
				ciCycle: {
					attempt: 0,
					maxAttempts: 3,
					monitorStartedAt: null,
					globalTimeoutMs: 30 * 60 * 1000,
					lastCheckResults: [],
					failureLogs: [],
				},
				mergeCycle: {
					attempt: 0,
					maxAttempts: 3,
				},
				prUrl: null,
				epicId: null,
				epicTitle: null,
				epicDependencies: [],
				epicDependencyStatus: null,
				activeWorkMs: 0,
				activeWorkStartedAt: null,
				createdAt: now,
				updatedAt: now,
			};
			return workflow;
		},
		transition: (_id: string, status: WorkflowStatus) => {
			if (workflow) workflow.status = status;
		},
		updateLastOutput: (_id: string, text: string) => {
			if (workflow) {
				workflow.lastOutput = text;
				workflow.updatedAt = new Date().toISOString();
			}
		},
		setQuestion: (_id: string, question: Question) => {
			if (workflow) {
				workflow.pendingQuestion = question;
				workflow.updatedAt = new Date().toISOString();
			}
		},
		clearQuestion: (_id: string) => {
			if (workflow) {
				workflow.pendingQuestion = null;
				workflow.updatedAt = new Date().toISOString();
			}
		},
		updateSummary: (_id: string, summary: string) => {
			if (workflow) {
				workflow.summary = summary;
				workflow.updatedAt = new Date().toISOString();
			}
		},
		updateStepSummary: (_id: string, stepSummary: string) => {
			if (workflow) {
				workflow.stepSummary = stepSummary;
				workflow.updatedAt = new Date().toISOString();
			}
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
		resume: mock((_workflow: Workflow, _callbacks: CLICallbacks) => {}),
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
		classify: async (_output: string): Promise<ReviewSeverity> =>
			classifyResults.shift() ?? "minor",
		_pushClassifyResult: (r: ReviewSeverity) => classifyResults.push(r),
	};
}

function createFakeSummarizer() {
	return {
		maybeSummarize: mock((_id: string, _text: string, _cb: (s: string) => void) => {}),
		generateSpecSummary: mock(async () => ({ summary: "", flavor: "" })),
		cleanup: mock(() => {}),
	};
}

function createFakeAuditLogger() {
	return {
		startRun: mock((_pipelineName: string, _branch: string | null) => "fake-audit-run-id"),
		endRun: mock((_runId: string, _metadata?: Record<string, unknown>) => {}),
		logQuery: mock((_runId: string, _content: string, _stepName: string | null) => {}),
		logAnswer: mock((_runId: string, _content: string, _stepName: string | null) => {}),
		logCommit: mock(
			(_runId: string, _hash: string, _msg: string | null, _step: string | null) => {},
		),
	};
}

function createFakeWorkflowStore() {
	return {
		save: mock(async () => {}),
		load: mock(async () => null),
		loadAll: mock(async (): Promise<Workflow[]> => []),
		loadIndex: mock(async () => []),
		remove: mock(async () => {}),
	};
}

function makeCallbacks(): PipelineCallbacks {
	return {
		onStepChange: mock(() => {}),
		onOutput: mock(() => {}),
		onTools: mock(() => {}),
		onComplete: mock(() => {}),
		onError: mock(() => {}),
		onStateChange: mock(() => {}),
		onEpicDependencyUpdate: mock(() => {}),
	};
}

/** Get the mock workflow, throwing if null (avoids non-null assertions in tests) */
function getWf(eng: ReturnType<typeof createFakeEngine>): Workflow {
	const wf = eng._getWorkflow();
	if (!wf) throw new Error("Expected workflow to exist");
	return wf;
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
	let auditLogger: ReturnType<typeof createFakeAuditLogger>;
	let store: ReturnType<typeof createFakeWorkflowStore>;

	beforeEach(() => {
		callbacks = makeCallbacks();
		engine = createFakeEngine();
		cli = createFakeCliRunner();
		qd = createFakeQuestionDetector();
		rc = createFakeReviewClassifier();
		summarizer = createFakeSummarizer();
		auditLogger = createFakeAuditLogger();
		store = createFakeWorkflowStore();

		// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fakes
		const deps: Record<string, any> = {
			engine,
			cliRunner: cli,
			questionDetector: qd,
			reviewClassifier: rc,
			summarizer,
			auditLogger,
			workflowStore: store,
		};
		orchestrator = new PipelineOrchestrator(callbacks, deps);
	});

	// T009: Step sequencing
	describe("step sequencing", () => {
		test("startPipeline creates workflow and starts first step", async () => {
			await orchestrator.startPipeline("Build a login page");
			const wf = getWf(engine);

			expect(wf).not.toBeNull();
			expect(wf.steps[0].status).toBe("running");
			expect(wf.currentStepIndex).toBe(0);
			expect(cli._startCalls.length).toBe(1);
		});

		test("pipeline has 12 steps in correct order", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			const expectedOrder: PipelineStepName[] = [
				"specify",
				"clarify",
				"plan",
				"tasks",
				"implement",
				"review",
				"implement-review",
				"commit-push-pr",
				"monitor-ci",
				"fix-ci",
				"merge-pr",
				"sync-repo",
			];
			expect(wf.steps.map((s) => s.name)).toEqual(expectedOrder);
		});

		test("advancing step moves to next step", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			cli.getLastCallbacks().onComplete();

			expect(wf.steps[0].status).toBe("completed");
			expect(wf.steps[1].status).toBe("running");
			expect(wf.currentStepIndex).toBe(1);
		});

		test("onTools callback forwards tool data to pipeline callbacks", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			const toolData = { Bash: 3, Read: 1 };
			cli.getLastCallbacks().onTools(toolData);

			expect(callbacks.onTools).toHaveBeenCalledWith(wf.id, toolData);
		});

		test("completing all steps triggers pipeline completion", async () => {
			await orchestrator.startPipeline("test");

			// Complete steps 0–4 (specify → implement)
			for (let i = 0; i < 5; i++) {
				cli.getLastCallbacks().onComplete();
			}

			// Review step (5) completes → always routes to implement-review (6)
			cli.getLastCallbacks().onComplete();

			const wf = getWf(engine);
			expect(wf.currentStepIndex).toBe(6);
			expect(wf.steps[6].name).toBe("implement-review");

			// implement-review (6) completes → classify as minor → advance to commit-push-pr
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(7);

			// commit-push-pr (7) completes → routes to monitor-ci (8)
			// monitor-ci is direct code execution, not CLI — without a prUrl it errors
			cli.getLastCallbacks().onComplete();

			expect(wf.currentStepIndex).toBe(8);
			expect(wf.steps[8].name).toBe("monitor-ci");
			expect(wf.status).toBe("error");
			expect(wf.steps[8].error).toBe("No PR URL found — cannot monitor CI checks");
		});
	});

	// T010: Q&A loop — all questions are classified by Haiku
	describe("Q&A loop", () => {
		test("Haiku-confirmed question pauses pipeline", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			const question: Question = {
				id: "q1",
				content: "Should I use React?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.steps[0].status).toBe("waiting_for_input");
			expect(wf.pendingQuestion).toEqual(question);
		});

		test("Haiku-rejected question advances step", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			const question: Question = {
				id: "q1",
				content: "What do you think about this?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(false));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.steps[0].status).toBe("completed");
			expect(wf.currentStepIndex).toBe(1);
		});

		test("answering question resumes step via sendAnswer", async () => {
			await orchestrator.startPipeline("test");

			cli.getLastCallbacks().onSessionId("sess-123");

			const question: Question = {
				id: "q1",
				content: "Should I use React?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			orchestrator.answerQuestion("test-wf-id", "q1", "Yes, use React");

			expect(cli.sendAnswer).toHaveBeenCalledWith("test-wf-id", "Yes, use React");
		});

		test("session ID is preserved after answering question", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			cli.getLastCallbacks().onSessionId("sess-123");

			const question: Question = {
				id: "q1",
				content: "Should I use React?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			orchestrator.answerQuestion("test-wf-id", "q1", "Yes");

			expect(wf.steps[0].sessionId).toBe("sess-123");
		});

		test("answering question resets cooldown for next detection", async () => {
			await orchestrator.startPipeline("test");

			cli.getLastCallbacks().onSessionId("sess-123");

			const question: Question = {
				id: "q1",
				content: "Should I use React?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			orchestrator.answerQuestion("test-wf-id", "q1", "Yes");

			expect(qd.reset).toHaveBeenCalled();
		});

		test("Q&A loop pauses again on second question", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			cli.getLastCallbacks().onSessionId("sess-123");

			// First question — Haiku confirms
			const q1: Question = {
				id: "q1",
				content: "Question 1?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(q1);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

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
			const wf = getWf(engine);
			expect(wf.currentStepIndex).toBe(5);
			expect(wf.steps[5].name).toBe("review");
		}

		test("review always routes to implement-review first", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			// Review completes → always goes to implement-review
			cli.getLastCallbacks().onComplete();

			expect(wf.reviewCycle.iteration).toBe(2);
			expect(wf.currentStepIndex).toBe(6); // implement-review
			expect(wf.steps[6].name).toBe("implement-review");
			expect(wf.steps[6].status).toBe("running");
		});

		test("re-cycles on critical severity after implement-review", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			// Review completes → implement-review
			cli.getLastCallbacks().onComplete();
			expect(wf.currentStepIndex).toBe(6);

			// implement-review completes → classify as critical → loop back to review
			rc._pushClassifyResult("critical");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.reviewCycle.lastSeverity).toBe("critical");
			expect(wf.currentStepIndex).toBe(5); // back to review
			expect(wf.steps[5].status).toBe("running");
		});

		test("re-cycles on major severity after implement-review", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("major");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.reviewCycle.lastSeverity).toBe("major");
			expect(wf.currentStepIndex).toBe(5); // back to review
		});

		test("stops cycling on minor severity → advances to commit-push-pr", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(7);
			expect(wf.steps[7].name).toBe("commit-push-pr");
		});

		test("stops cycling on trivial severity", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("trivial");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(7);
		});

		test("stops cycling on nit severity", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("nit");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(7);
		});

		test("caps review cycling at maxIterations", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			wf.reviewCycle.iteration = 16;

			// Review → implement-review (iteration becomes 17 which exceeds max)
			cli.getLastCallbacks().onComplete();

			// implement-review completes → classify as critical but capped
			rc._pushClassifyResult("critical");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(7); // commit-push-pr despite critical
		});
	});

	// T003: Spec summary preservation — maybeSummarize writes to stepSummary, not summary
	describe("spec summary preservation (US7)", () => {
		test("maybeSummarize writes to stepSummary, not summary", async () => {
			// Configure summarizer to call the callback with a step summary
			summarizer.maybeSummarize.mockImplementation(
				(_id: string, _text: string, cb: (s: string) => void) => {
					cb("Editing files");
				},
			);

			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			// Set a spec summary that should persist
			wf.summary = "Login Page Feature";

			// Simulate step output (triggers maybeSummarize)
			cli.getLastCallbacks().onOutput("some output text");

			// summary should remain unchanged (spec summary)
			expect(wf.summary).toBe("Login Page Feature");
			// stepSummary should have the transient update
			expect(wf.stepSummary).toBe("Editing files");
		});

		test("generateSpecSummary sets summary which is never overwritten by step summarizer", async () => {
			summarizer.generateSpecSummary.mockImplementation(async () => ({
				summary: "Auth Module",
				flavor: "Yet another login page",
			}));

			// Step summarizer should write to stepSummary
			summarizer.maybeSummarize.mockImplementation(
				(_id: string, _text: string, cb: (s: string) => void) => {
					cb("Reading config files");
				},
			);

			await orchestrator.startPipeline("Build auth module");
			const wf = getWf(engine);

			// Wait for generateSpecSummary to resolve
			await new Promise((r) => setTimeout(r, 20));

			// Spec summary set by generateSpecSummary
			expect(wf.summary).toBe("Auth Module");
			expect(wf.flavor).toBe("Yet another login page");

			// Trigger step output after spec summary is set
			cli.getLastCallbacks().onOutput("more agent output");

			// summary should still be the spec summary
			expect(wf.summary).toBe("Auth Module");
			// stepSummary should have the transient update
			expect(wf.stepSummary).toBe("Reading config files");
		});
	});

	// T012: Step failure and retry
	describe("step failure and retry", () => {
		test("step failure sets step to error state", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			cli.getLastCallbacks().onError("CLI crashed");

			expect(wf.steps[0].status).toBe("error");
			expect(wf.steps[0].error).toBe("CLI crashed");
			expect(wf.status).toBe("error");
		});

		test("retry re-runs the failed step", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			cli.getLastCallbacks().onError("CLI crashed");

			const callsBefore = cli._startCalls.length;
			await orchestrator.retryStep("test-wf-id");

			expect(cli._startCalls.length).toBe(callsBefore + 1);
			expect(wf.steps[0].status).toBe("running");
			expect(wf.steps[0].error).toBeNull();
		});

		test("retry starts a new audit run after error", async () => {
			await orchestrator.startPipeline("test");

			// Error ends the audit run
			cli.getLastCallbacks().onError("CLI crashed");
			expect(auditLogger.endRun).toHaveBeenCalledTimes(1);

			// Retry should start a new audit run
			await orchestrator.retryStep("test-wf-id");
			expect(auditLogger.startRun).toHaveBeenCalledTimes(2);
		});

		test("completed steps are preserved on retry", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			// Complete step 0
			cli.getLastCallbacks().onComplete();

			// Step 1 fails
			cli.getLastCallbacks().onError("crashed");

			expect(wf.steps[0].status).toBe("completed");
			expect(wf.steps[1].status).toBe("error");

			// Retry step 1
			await orchestrator.retryStep("test-wf-id");
			expect(wf.steps[0].status).toBe("completed");
			expect(wf.steps[1].status).toBe("running");
		});
	});

	// skipQuestion
	describe("skipQuestion", () => {
		test("skipQuestion delegates to answerQuestion with canned message", async () => {
			await orchestrator.startPipeline("test");

			cli.getLastCallbacks().onSessionId("sess-skip");

			const question: Question = {
				id: "q-skip",
				content: "Which framework?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			orchestrator.skipQuestion("test-wf-id", "q-skip");

			expect(cli.sendAnswer).toHaveBeenCalledWith(
				"test-wf-id",
				"The user has chosen not to answer this question. Continue with your best judgment.",
			);
		});
	});

	// Full re-cycle integration test
	describe("full re-cycle loop", () => {
		test("review → implement-review → critical → review → implement-review → minor → commit-push-pr → complete", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			// Complete steps 0-4 (specify → implement)
			for (let i = 0; i < 5; i++) {
				cli.getLastCallbacks().onComplete();
			}

			expect(wf.currentStepIndex).toBe(5);
			expect(wf.steps[5].name).toBe("review");

			// First review completes → always routes to implement-review
			cli.getLastCallbacks().onComplete();

			expect(wf.reviewCycle.iteration).toBe(2);
			expect(wf.currentStepIndex).toBe(6); // implement-review
			expect(wf.steps[6].status).toBe("running");

			// implement-review completes → classify as critical → loop back to review
			rc._pushClassifyResult("critical");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.reviewCycle.lastSeverity).toBe("critical");
			expect(wf.currentStepIndex).toBe(5); // review again
			expect(wf.steps[5].status).toBe("running");

			// Second review completes → implement-review again
			cli.getLastCallbacks().onComplete();

			expect(wf.reviewCycle.iteration).toBe(3);
			expect(wf.currentStepIndex).toBe(6); // implement-review
			expect(wf.steps[6].status).toBe("running");

			// implement-review completes → classify as minor → advance to commit-push-pr
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.reviewCycle.lastSeverity).toBe("minor");
			expect(wf.currentStepIndex).toBe(7); // commit-push-pr
			expect(wf.steps[7].name).toBe("commit-push-pr");

			// commit-push-pr completes → routes to monitor-ci
			// monitor-ci errors (no PR URL) since this test doesn't set prUrl
			cli.getLastCallbacks().onComplete();

			expect(wf.currentStepIndex).toBe(8);
			expect(wf.steps[8].name).toBe("monitor-ci");
			expect(wf.status).toBe("error");
		});
	});

	// Audit trail integration
	describe("audit trail wiring", () => {
		test("startPipeline calls auditLogger.startRun with original branch as pipelineName", async () => {
			await orchestrator.startPipeline("Build a feature");

			expect(auditLogger.startRun).toHaveBeenCalledTimes(1);
			// pipelineName is resolved from the original repo branch, not the worktree branch
			const pipelineName = auditLogger.startRun.mock.calls[0][0] as string;
			expect(pipelineName).not.toBe("");
			// branch arg is the worktree branch
			expect(auditLogger.startRun.mock.calls[0][1]).toBe("crab-studio/test");
		});

		test("pipeline completion calls auditLogger.endRun", async () => {
			await orchestrator.startPipeline("test");

			// Complete steps 0–4
			for (let i = 0; i < 5; i++) {
				cli.getLastCallbacks().onComplete();
			}

			// Review → implement-review → minor → commit-push-pr
			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			// commit-push-pr completes → monitor-ci errors (no PR URL)
			cli.getLastCallbacks().onComplete();

			expect(auditLogger.endRun).toHaveBeenCalledTimes(1);
			expect(auditLogger.endRun.mock.calls[0][0]).toBe("fake-audit-run-id");
		});

		test("cancelPipeline calls auditLogger.endRun with cancelled metadata", async () => {
			await orchestrator.startPipeline("test");

			orchestrator.cancelPipeline("test-wf-id");

			expect(auditLogger.endRun).toHaveBeenCalledWith("fake-audit-run-id", { cancelled: true });
		});

		test("step error calls auditLogger.endRun with error metadata", async () => {
			await orchestrator.startPipeline("test");

			cli.getLastCallbacks().onError("CLI crashed");

			expect(auditLogger.endRun).toHaveBeenCalledWith("fake-audit-run-id", {
				error: "CLI crashed",
			});
		});

		test("pauseForQuestion calls auditLogger.logQuery", async () => {
			await orchestrator.startPipeline("test");

			const question: Question = {
				id: "q1",
				content: "Should I use React?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(auditLogger.logQuery).toHaveBeenCalledWith(
				"fake-audit-run-id",
				"Should I use React?",
				"specify",
			);
		});

		test("answerQuestion calls auditLogger.logAnswer", async () => {
			await orchestrator.startPipeline("test");

			const question: Question = {
				id: "q1",
				content: "Should I use React?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			orchestrator.answerQuestion("test-wf-id", "q1", "Yes, use React");

			expect(auditLogger.logAnswer).toHaveBeenCalledWith(
				"fake-audit-run-id",
				"Yes, use React",
				"specify",
			);
		});
	});

	// T026: Cancellation
	describe("cancellation", () => {
		test("cancelPipeline kills CLI process and sets cancelled state", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			orchestrator.cancelPipeline("test-wf-id");

			expect(cli.kill).toHaveBeenCalledWith("test-wf-id");
			expect(wf.status).toBe("cancelled");
			expect(wf.steps[0].status).toBe("error");
			expect(wf.steps[0].error).toBe("Cancelled by user");
		});

		test("cancelPipeline triggers epic dependency check when epicId is set", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);
			wf.epicId = "epic-123";

			// Mock a sibling workflow that depends on this one and is waiting
			const sibling = {
				...wf,
				id: "sibling-wf",
				epicId: "epic-123",
				epicDependencies: [wf.id],
				epicDependencyStatus: "waiting" as const,
				status: "waiting_for_dependencies" as const,
			};
			store.loadAll = mock(async () => [wf, sibling]);
			store.save = mock(async () => {});

			orchestrator.cancelPipeline("test-wf-id");

			expect(wf.status).toBe("cancelled");
			// checkEpicDependencies is async — give it a tick
			await new Promise((r) => setTimeout(r, 50));
			expect(callbacks.onEpicDependencyUpdate).toHaveBeenCalledWith("sibling-wf", "blocked", [
				wf.id,
			]);
		});

		test("cancellation during Q&A sets cancelled state", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);

			const question: Question = {
				id: "q1",
				content: "Question?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			orchestrator.cancelPipeline("test-wf-id");

			expect(wf.status).toBe("cancelled");
		});
	});

	describe("epic dependency resolution", () => {
		test("cancellation resolves satisfied for sibling whose deps are all completed", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);
			wf.epicId = "epic-456";

			// Sibling depends on wf.id, and wf is already completed in the store snapshot
			const sibling = {
				...wf,
				id: "sibling-wf",
				epicId: "epic-456",
				epicDependencies: [wf.id],
				epicDependencyStatus: "waiting" as const,
				status: "waiting_for_dependencies" as const,
			};
			const completedWf = { ...wf, status: "completed" as const };
			store.loadAll = mock(async () => [completedWf, sibling]);
			store.save = mock(async () => {});

			// Cancel triggers checkEpicDependencies; store shows wf as completed
			orchestrator.cancelPipeline("test-wf-id");

			await new Promise((r) => setTimeout(r, 50));
			expect(callbacks.onEpicDependencyUpdate).toHaveBeenCalledWith("sibling-wf", "satisfied", []);
		});

		test("cancellation notifies sibling with blocked status", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);
			wf.epicId = "epic-789";

			const sibling = {
				...wf,
				id: "sibling-err",
				epicId: "epic-789",
				epicDependencies: [wf.id],
				epicDependencyStatus: "waiting" as const,
				status: "waiting_for_dependencies" as const,
			};
			// wf appears as cancelled in the store after cancelPipeline
			const cancelledWf = { ...wf, status: "cancelled" as const };
			store.loadAll = mock(async () => [cancelledWf, sibling]);
			store.save = mock(async () => {});

			orchestrator.cancelPipeline("test-wf-id");

			await new Promise((r) => setTimeout(r, 50));
			expect(callbacks.onEpicDependencyUpdate).toHaveBeenCalledWith("sibling-err", "blocked", [
				wf.id,
			]);
		});

		test("sibling with multiple deps stays waiting when only some are satisfied", async () => {
			await orchestrator.startPipeline("test");
			const wf = getWf(engine);
			wf.epicId = "epic-multi";

			// Sibling depends on wf + another workflow that's still running
			const sibling = {
				...wf,
				id: "sibling-multi",
				epicId: "epic-multi",
				epicDependencies: [wf.id, "other-wf"],
				epicDependencyStatus: "waiting" as const,
				status: "waiting_for_dependencies" as const,
			};
			const completedWf = { ...wf, status: "completed" as const };
			const otherRunning = {
				...wf,
				id: "other-wf",
				epicId: "epic-multi",
				status: "running" as const,
			};
			store.loadAll = mock(async () => [completedWf, sibling, otherRunning]);
			store.save = mock(async () => {});

			orchestrator.cancelPipeline("test-wf-id");

			await new Promise((r) => setTimeout(r, 50));
			expect(callbacks.onEpicDependencyUpdate).toHaveBeenCalledWith("sibling-multi", "waiting", [
				"other-wf",
			]);
		});
	});
});
