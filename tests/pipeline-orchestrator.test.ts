import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CLICallbacks } from "../src/cli-runner";
import { configStore, DEFAULT_CONFIG } from "../src/config-store";
import { type PipelineCallbacks, PipelineOrchestrator } from "../src/pipeline-orchestrator";
import type {
	PipelineStepName,
	Question,
	ReviewSeverity,
	SetupResult,
	Workflow,
	WorkflowStatus,
} from "../src/types";
import { PIPELINE_STEP_DEFINITIONS } from "../src/types";

// ── Fake dependencies (no mock.module — uses DI) ──────────────────────

function createFakeEngine() {
	let workflow: Workflow | null = null;

	return {
		getWorkflow: () => workflow,
		createWorkflow: async (spec: string, targetRepository: string) => {
			const now = new Date().toISOString();
			workflow = {
				id: "test-wf-id",
				specification: spec,
				status: "idle" as WorkflowStatus,
				targetRepository,
				worktreePath: null,
				worktreeBranch: "tmp-test0001",
				featureBranch: null,
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
				epicAnalysisMs: 0,
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
		createWorktree: async (_shortId: string, _cwd: string) => {
			if (workflow) workflow.worktreePath = "/tmp/test-worktree";
			return "/tmp/test-worktree";
		},
		copyGitignoredFiles: async (_src: string, _dest: string) => {},
		removeWorktree: async (_worktreePath: string, _targetRepo: string) => {},
		moveWorktree: async () => "/tmp/test-worktree",
		// Expose for test assertions
		_getWorkflow: () => workflow,
	};
}

function createFakeCliRunner() {
	const startCalls: Array<{
		workflow: Workflow;
		callbacks: CLICallbacks;
		extraEnv?: Record<string, string>;
	}> = [];

	return {
		start: (workflow: Workflow, callbacks: CLICallbacks, extraEnv?: Record<string, string>) => {
			startCalls.push({ workflow, callbacks, extraEnv });
			// Emit output so the empty-output guard in handleStepComplete passes
			callbacks.onOutput("[test] CLI step running");
		},
		kill: mock((_id: string) => {}),
		resume: mock(
			(
				_id: string,
				_sessionId: string,
				_cwd: string,
				_callbacks: CLICallbacks,
				_extraEnv?: Record<string, string>,
				_prompt?: string,
			) => {},
		),
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
		resetBuffer: mock((_id: string) => {}),
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
		configStore.save({ autoMode: "normal" });
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
			runSetupChecks: async () => ({
				passed: true,
				checks: [],
				requiredFailures: [],
				optionalWarnings: [],
			}),
			checkoutMaster: async () => ({ code: 0, stderr: "" }),
		};
		orchestrator = new PipelineOrchestrator(callbacks, deps);
	});

	/** Start pipeline and flush microtasks so the mocked setup step auto-completes */
	async function startAndFlush(spec: string, targetRepository?: string) {
		const wf = await orchestrator.startPipeline(spec, targetRepository ?? "/tmp/test-repo");
		await new Promise((r) => setTimeout(r, 0));
		return wf;
	}

	// T009: Step sequencing
	describe("step sequencing", () => {
		test("startPipeline creates workflow and starts first step (setup)", async () => {
			await startAndFlush("Build a login page");
			const wf = getWf(engine);

			expect(wf).not.toBeNull();
			// Setup auto-completed, now specify (index 1) is running
			expect(wf.steps[0].status).toBe("completed");
			expect(wf.steps[1].status).toBe("running");
			expect(wf.currentStepIndex).toBe(1);
			expect(cli._startCalls.length).toBe(1);
		});

		test("pipeline has 13 steps in correct order", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			const expectedOrder: PipelineStepName[] = [
				"setup",
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
			await startAndFlush("test");
			const wf = getWf(engine);

			// Specify (index 1) is running; complete it
			cli.getLastCallbacks().onComplete();

			expect(wf.steps[1].status).toBe("completed");
			expect(wf.steps[2].status).toBe("running");
			expect(wf.currentStepIndex).toBe(2);
		});

		test("onTools callback forwards tool data to pipeline callbacks", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			const toolData = [{ name: "Bash", input: { command: "ls" } }, { name: "Read" }];
			cli.getLastCallbacks().onTools(toolData);

			expect(callbacks.onTools).toHaveBeenCalledWith(wf.id, toolData);
		});

		test("completing all steps triggers pipeline completion", async () => {
			await startAndFlush("test");

			// Complete steps 1–5 (specify → implement); setup (0) already completed
			for (let i = 0; i < 5; i++) {
				cli.getLastCallbacks().onComplete();
			}

			// Review step (6) completes → always routes to implement-review (7)
			cli.getLastCallbacks().onComplete();

			const wf = getWf(engine);
			expect(wf.currentStepIndex).toBe(7);
			expect(wf.steps[7].name).toBe("implement-review");

			// implement-review (7) completes → classify as minor → advance to commit-push-pr
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(8);

			// commit-push-pr (8) completes → routes to monitor-ci (9)
			// monitor-ci tries to discover PR URL asynchronously, then errors
			cli.getLastCallbacks().onComplete();

			expect(wf.currentStepIndex).toBe(9);
			expect(wf.steps[9].name).toBe("monitor-ci");

			// Wait for async PR URL discovery to fail
			await new Promise((r) => setTimeout(r, 200));

			expect(wf.status).toBe("error");
		});
	});

	// T010: Q&A loop — all questions are classified by Haiku
	describe("Q&A loop", () => {
		test("Haiku-confirmed question pauses pipeline", async () => {
			await startAndFlush("test");
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

			expect(wf.steps[1].status).toBe("waiting_for_input");
			expect(wf.pendingQuestion).toEqual(question);
		});

		test("Haiku-rejected question advances step", async () => {
			await startAndFlush("test");
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

			expect(wf.steps[1].status).toBe("completed");
			expect(wf.currentStepIndex).toBe(2);
		});

		test("answering question resumes step via --resume", async () => {
			await startAndFlush("test");

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

			expect(cli.kill).toHaveBeenCalledWith("test-wf-id");
			expect(cli.resume).toHaveBeenCalled();
			const resumeCall = (cli.resume.mock.calls as unknown[][])[cli.resume.mock.calls.length - 1];
			expect(resumeCall[0]).toBe("test-wf-id");
			expect(resumeCall[1]).toBe("sess-123");
			expect(resumeCall[5]).toBe("Yes, use React");
		});

		test("session ID is preserved after answering question", async () => {
			await startAndFlush("test");
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

			expect(wf.steps[1].sessionId).toBe("sess-123");
		});

		test("answering question resets cooldown for next detection", async () => {
			await startAndFlush("test");

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
			await startAndFlush("test");
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

			// Answer → resume called with answer as prompt
			orchestrator.answerQuestion("test-wf-id", "q1", "Answer 1");
			const resumeCall = (cli.resume.mock.calls as unknown[][])[cli.resume.mock.calls.length - 1];
			expect(resumeCall[0]).toBe("test-wf-id");
			expect(resumeCall[5]).toBe("Answer 1");
		});
	});

	// T011: Review cycling
	describe("review cycling", () => {
		async function advanceToReview() {
			await startAndFlush("test");
			// Complete steps 1-5 (specify → implement); setup (0) already completed
			for (let i = 0; i < 5; i++) {
				cli.getLastCallbacks().onComplete();
			}
			const wf = getWf(engine);
			expect(wf.currentStepIndex).toBe(6);
			expect(wf.steps[6].name).toBe("review");
		}

		test("review always routes to implement-review first", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			// Review completes → always goes to implement-review
			cli.getLastCallbacks().onComplete();

			expect(wf.reviewCycle.iteration).toBe(2);
			expect(wf.currentStepIndex).toBe(7); // implement-review
			expect(wf.steps[7].name).toBe("implement-review");
			expect(wf.steps[7].status).toBe("running");
		});

		test("re-cycles on critical severity after implement-review", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			// Review completes → implement-review
			cli.getLastCallbacks().onComplete();
			expect(wf.currentStepIndex).toBe(7);

			// implement-review completes → classify as critical → loop back to review
			rc._pushClassifyResult("critical");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.reviewCycle.lastSeverity).toBe("critical");
			expect(wf.currentStepIndex).toBe(6); // back to review
			expect(wf.steps[6].status).toBe("running");
		});

		test("re-cycles on major severity after implement-review", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("major");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.reviewCycle.lastSeverity).toBe("major");
			expect(wf.currentStepIndex).toBe(6); // back to review
		});

		test("stops cycling on minor severity → advances to commit-push-pr", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(8);
			expect(wf.steps[8].name).toBe("commit-push-pr");
		});

		test("stops cycling on trivial severity", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("trivial");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(8);
		});

		test("stops cycling on nit severity", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("nit");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(8);
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

			expect(wf.currentStepIndex).toBe(8); // commit-push-pr despite critical
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

			await startAndFlush("test");
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

			await startAndFlush("Build auth module");
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
			await startAndFlush("test");
			const wf = getWf(engine);

			cli.getLastCallbacks().onError("CLI crashed");

			expect(wf.steps[1].status).toBe("error");
			expect(wf.steps[1].error).toBe("CLI crashed");
			expect(wf.status).toBe("error");
		});

		test("retry re-runs the failed step", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			cli.getLastCallbacks().onError("CLI crashed");

			const callsBefore = cli._startCalls.length;
			await orchestrator.retryStep("test-wf-id");

			expect(cli._startCalls.length).toBe(callsBefore + 1);
			expect(wf.steps[1].status).toBe("running");
			expect(wf.steps[1].error).toBeNull();
		});

		test("retry starts a new audit run after error", async () => {
			await startAndFlush("test");

			// Error ends the audit run
			cli.getLastCallbacks().onError("CLI crashed");
			expect(auditLogger.endRun).toHaveBeenCalledTimes(1);

			// Retry should start a new audit run
			await orchestrator.retryStep("test-wf-id");
			expect(auditLogger.startRun).toHaveBeenCalledTimes(2);
		});

		test("completed steps are preserved on retry", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			// Complete step 1 (specify)
			cli.getLastCallbacks().onComplete();

			// Step 2 (clarify) fails
			cli.getLastCallbacks().onError("crashed");

			expect(wf.steps[1].status).toBe("completed");
			expect(wf.steps[2].status).toBe("error");

			// Retry step 2
			await orchestrator.retryStep("test-wf-id");
			expect(wf.steps[1].status).toBe("completed");
			expect(wf.steps[2].status).toBe("running");
		});
	});

	// skipQuestion
	describe("skipQuestion", () => {
		test("skipQuestion delegates to answerQuestion with canned message", async () => {
			await startAndFlush("test");

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

			const resumeCall = (cli.resume.mock.calls as unknown[][])[cli.resume.mock.calls.length - 1];
			expect(resumeCall[0]).toBe("test-wf-id");
			expect(resumeCall[5]).toBe(
				"The user has chosen not to answer this question. Continue with your best judgment.",
			);
		});
	});

	// Full re-cycle integration test
	describe("full re-cycle loop", () => {
		test("review → implement-review → critical → review → implement-review → minor → commit-push-pr → complete", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			// Complete steps 1-5 (specify → implement); setup (0) already completed
			for (let i = 0; i < 5; i++) {
				cli.getLastCallbacks().onComplete();
			}

			expect(wf.currentStepIndex).toBe(6);
			expect(wf.steps[6].name).toBe("review");

			// First review completes → always routes to implement-review
			cli.getLastCallbacks().onComplete();

			expect(wf.reviewCycle.iteration).toBe(2);
			expect(wf.currentStepIndex).toBe(7); // implement-review
			expect(wf.steps[7].status).toBe("running");

			// implement-review completes → classify as critical → loop back to review
			rc._pushClassifyResult("critical");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.reviewCycle.lastSeverity).toBe("critical");
			expect(wf.currentStepIndex).toBe(6); // review again
			expect(wf.steps[6].status).toBe("running");

			// Second review completes → implement-review again
			cli.getLastCallbacks().onComplete();

			expect(wf.reviewCycle.iteration).toBe(3);
			expect(wf.currentStepIndex).toBe(7); // implement-review
			expect(wf.steps[7].status).toBe("running");

			// implement-review completes → classify as minor → advance to commit-push-pr
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.reviewCycle.lastSeverity).toBe("minor");
			expect(wf.currentStepIndex).toBe(8); // commit-push-pr
			expect(wf.steps[8].name).toBe("commit-push-pr");

			// commit-push-pr completes → routes to monitor-ci
			// monitor-ci tries to discover PR URL asynchronously, then errors
			cli.getLastCallbacks().onComplete();

			expect(wf.currentStepIndex).toBe(9);
			expect(wf.steps[9].name).toBe("monitor-ci");

			// Wait for async PR URL discovery to fail
			await new Promise((r) => setTimeout(r, 200));

			expect(wf.status).toBe("error");
		});
	});

	// Audit trail integration
	describe("audit trail wiring", () => {
		test("startPipeline calls auditLogger.startRun with original branch as pipelineName", async () => {
			await startAndFlush("Build a feature");

			expect(auditLogger.startRun).toHaveBeenCalledTimes(1);
			// pipelineName is resolved from the original repo branch, not the worktree branch
			const pipelineName = auditLogger.startRun.mock.calls[0][0] as string;
			expect(pipelineName).not.toBe("");
			// branch arg is the worktree branch
			expect(auditLogger.startRun.mock.calls[0][1]).toBe("tmp-test0001");
		});

		test("pipeline completion calls auditLogger.endRun", async () => {
			await startAndFlush("test");

			// Complete steps 1–5 (specify → implement); setup (0) already completed
			for (let i = 0; i < 5; i++) {
				cli.getLastCallbacks().onComplete();
			}

			// Review → implement-review → minor → commit-push-pr
			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			// commit-push-pr completes → monitor-ci tries to discover PR URL, then errors
			cli.getLastCallbacks().onComplete();

			// Wait for async PR URL discovery to fail
			await new Promise((r) => setTimeout(r, 200));

			expect(auditLogger.endRun).toHaveBeenCalledTimes(1);
			expect(auditLogger.endRun.mock.calls[0][0]).toBe("fake-audit-run-id");
		});

		test("cancelPipeline calls auditLogger.endRun with cancelled metadata", async () => {
			await startAndFlush("test");

			orchestrator.cancelPipeline("test-wf-id");

			expect(auditLogger.endRun).toHaveBeenCalledWith("fake-audit-run-id", { cancelled: true });
		});

		test("step error calls auditLogger.endRun with error metadata", async () => {
			await startAndFlush("test");

			cli.getLastCallbacks().onError("CLI crashed");

			expect(auditLogger.endRun).toHaveBeenCalledWith("fake-audit-run-id", {
				error: "CLI crashed",
			});
		});

		test("pauseForQuestion calls auditLogger.logQuery", async () => {
			await startAndFlush("test");

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
			await startAndFlush("test");

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
			await startAndFlush("test");
			const wf = getWf(engine);

			orchestrator.cancelPipeline("test-wf-id");

			expect(cli.kill).toHaveBeenCalledWith("test-wf-id");
			expect(wf.status).toBe("cancelled");
			expect(wf.steps[1].status).toBe("error");
			expect(wf.steps[1].error).toBe("Cancelled by user");
		});

		test("cancelPipeline triggers epic dependency check when epicId is set", async () => {
			await startAndFlush("test");
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
			await startAndFlush("test");
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
			await startAndFlush("test");
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
			await startAndFlush("test");
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
			await startAndFlush("test");
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

	describe("pause and resume", () => {
		test("pause() kills process, sets step to paused, transitions workflow to paused", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			// Simulate session ID being set
			wf.steps[1].sessionId = "test-session-123";

			orchestrator.pause("test-wf-id");

			expect(cli.kill).toHaveBeenCalledWith("test-wf-id");
			expect(wf.steps[1].status).toBe("paused");
			expect(wf.status).toBe("paused");
			expect(wf.steps[1].sessionId).toBe("test-session-123");
			expect(store.save).toHaveBeenCalled();
			expect(callbacks.onStateChange).toHaveBeenCalledWith("test-wf-id");
		});

		test("pause() silently ignores if workflow is not running", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			// Set to completed
			wf.status = "completed";
			orchestrator.pause("test-wf-id");

			// Should not have changed anything
			expect(wf.status).toBe("completed");
		});

		test("resume() restarts CLI with session, sets step to running, transitions workflow to running", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			wf.steps[1].sessionId = "test-session-123";
			orchestrator.pause("test-wf-id");

			orchestrator.resume("test-wf-id");

			expect(wf.steps[1].status).toBe("running");
			expect(wf.status).toBe("running");
			expect(cli.resume).toHaveBeenCalled();
			expect(callbacks.onStateChange).toHaveBeenCalledWith("test-wf-id");
		});

		test("resume() silently ignores if workflow is not paused", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			// Still running — resume should be a no-op
			orchestrator.resume("test-wf-id");

			// resume mock should not have been called for resume flow
			expect(wf.status).toBe("running");
		});

		test("resume() without sessionId falls back to runStep (cliRunner.start)", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			// Clear sessionId so resume takes the fallback branch
			wf.steps[1].sessionId = null;
			wf.steps[1].status = "running";

			const resumeCallsBefore = (cli.resume as ReturnType<typeof mock>).mock.calls.length;
			orchestrator.pause("test-wf-id");
			const startCallsBefore = cli._startCalls.length;

			orchestrator.resume("test-wf-id");

			expect(wf.steps[1].status).toBe("running");
			expect(wf.status).toBe("running");
			// Should have triggered a new start call (runStep), not cliRunner.resume
			expect(cli._startCalls.length).toBe(startCallsBefore + 1);
			expect((cli.resume as ReturnType<typeof mock>).mock.calls.length).toBe(resumeCallsBefore);
		});

		test("resume() on monitor-ci step calls runMonitorCi (not cliRunner.resume)", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			// Advance to monitor-ci step (index 8) and set prUrl so runMonitorCi doesn't error
			const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
			wf.currentStepIndex = monitorIndex;
			wf.steps[monitorIndex].status = "running";
			wf.prUrl = "https://github.com/test/repo/pull/1";

			orchestrator.pause("test-wf-id");
			expect(wf.steps[monitorIndex].status as string).toBe("paused");

			// Resume — should NOT call cliRunner.resume since monitor-ci has no session
			const resumeCallsBefore = (cli.resume as ReturnType<typeof mock>).mock.calls.length;
			const startCallsBefore = cli._startCalls.length;
			orchestrator.resume("test-wf-id");

			expect(wf.steps[monitorIndex].status).toBe("running");
			expect(wf.status).toBe("running");
			// cliRunner.resume should NOT have been called for monitor-ci
			expect((cli.resume as ReturnType<typeof mock>).mock.calls.length).toBe(resumeCallsBefore);
			// cliRunner.start should NOT have been called either (monitor-ci uses startMonitoring)
			expect(cli._startCalls.length).toBe(startCallsBefore);
		});

		test("abort from paused: cancelPipeline sets step to error and workflow to cancelled", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			wf.steps[1].sessionId = "test-session-123";
			orchestrator.pause("test-wf-id");

			expect(wf.status).toBe("paused");
			expect(wf.steps[1].status).toBe("paused");

			orchestrator.cancelPipeline("test-wf-id");

			expect(wf.steps[1].status).toBe("error");
			expect(wf.steps[1].error).toBe("Cancelled by user");
			expect(wf.status).toBe("cancelled");
			expect(store.save).toHaveBeenCalled();
		});

		test("resume() passes SPECIFY_FEATURE env when featureBranch is set", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			wf.steps[1].sessionId = "test-session-123";
			wf.featureBranch = "021-my-feature";
			orchestrator.pause("test-wf-id");

			orchestrator.resume("test-wf-id");

			const resumeCalls = (cli.resume as ReturnType<typeof mock>).mock.calls;
			const lastCall = resumeCalls[resumeCalls.length - 1];
			// extraEnv is the 5th argument (index 4)
			expect(lastCall[4]).toEqual({ SPECIFY_FEATURE: "021-my-feature" });
		});
	});

	describe("feature branch detection after specify", () => {
		test("detects sequential feature branch from specs/ dir after specify completes", async () => {
			const tmpDir = join(tmpdir(), `crab-test-${Date.now()}`);
			mkdirSync(join(tmpDir, "specs", "021-my-feature"), { recursive: true });

			try {
				await startAndFlush("test");
				const wf = getWf(engine);
				wf.worktreePath = tmpDir;

				// Simulate specify step completing
				cli.getLastCallbacks().onComplete();
				await new Promise((r) => setTimeout(r, 20));

				expect(wf.featureBranch).toBe("021-my-feature");
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test("detects timestamp feature branch from specs/ dir", async () => {
			const tmpDir = join(tmpdir(), `crab-test-${Date.now()}`);
			mkdirSync(join(tmpDir, "specs", "20260401-120000-my-feature"), {
				recursive: true,
			});
			mkdirSync(join(tmpDir, "specs", "019-old-feature"), {
				recursive: true,
			});

			try {
				await startAndFlush("test");
				const wf = getWf(engine);
				wf.worktreePath = tmpDir;

				cli.getLastCallbacks().onComplete();
				await new Promise((r) => setTimeout(r, 20));

				// Timestamp branch should win over sequential
				expect(wf.featureBranch).toBe("20260401-120000-my-feature");
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test("passes SPECIFY_FEATURE to next step after specify", async () => {
			const tmpDir = join(tmpdir(), `crab-test-${Date.now()}`);
			mkdirSync(join(tmpDir, "specs", "021-my-feature"), { recursive: true });

			try {
				await startAndFlush("test");
				const wf = getWf(engine);
				wf.worktreePath = tmpDir;

				// Specify completes → next step (clarify) starts
				cli.getLastCallbacks().onComplete();
				await new Promise((r) => setTimeout(r, 20));

				// The clarify step should have been started with SPECIFY_FEATURE env
				const lastStart = cli._startCalls[cli._startCalls.length - 1];
				expect(lastStart.extraEnv).toEqual({
					SPECIFY_FEATURE: "021-my-feature",
				});
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	// Setup step routing tests
	describe("setup step routing", () => {
		function makeSetupOrchestrator(setupResult: SetupResult) {
			const localEngine = createFakeEngine();
			const localCli = createFakeCliRunner();
			const localQd = createFakeQuestionDetector();
			const localRc = createFakeReviewClassifier();
			const localCallbacks = makeCallbacks();
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fakes
			const deps: Record<string, any> = {
				engine: localEngine,
				cliRunner: localCli,
				questionDetector: localQd,
				reviewClassifier: localRc,
				summarizer: createFakeSummarizer(),
				auditLogger: createFakeAuditLogger(),
				workflowStore: createFakeWorkflowStore(),
				runSetupChecks: async () => setupResult,
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
			};
			const orch = new PipelineOrchestrator(localCallbacks, deps);
			return { orch, engine: localEngine, cli: localCli, callbacks: localCallbacks };
		}

		test("required failure halts pipeline with error", async () => {
			const { orch, engine } = makeSetupOrchestrator({
				passed: false,
				checks: [
					{ name: "Git installed", passed: true, required: true },
					{ name: "Git repository", passed: false, error: "Not a git repo", required: true },
				],
				requiredFailures: [
					{ name: "Git repository", passed: false, error: "Not a git repo", required: true },
				],
				optionalWarnings: [],
			});

			await orch.startPipeline("test", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 0));

			const wf = getWf(engine);
			expect(wf.steps[0].name).toBe("setup");
			expect(wf.steps[0].status).toBe("error");
			expect(wf.steps[0].error).toContain("Not a git repo");
			expect(wf.status).toBe("error");
		});

		test("optional warnings pause with question", async () => {
			const { orch, engine } = makeSetupOrchestrator({
				passed: true,
				checks: [
					{ name: "Git installed", passed: true, required: true },
					{
						name: "Gitignore: specs/",
						passed: false,
						error: '"specs/" not in .gitignore',
						required: false,
					},
				],
				requiredFailures: [],
				optionalWarnings: [
					{
						name: "Gitignore: specs/",
						passed: false,
						error: '"specs/" not in .gitignore',
						required: false,
					},
				],
			});

			await orch.startPipeline("test", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 0));

			const wf = getWf(engine);
			expect(wf.steps[0].name).toBe("setup");
			expect(wf.steps[0].status).toBe("waiting_for_input");
			expect(wf.pendingQuestion).toBeDefined();
			expect(wf.pendingQuestion?.content).toContain("specs/");
		});

		test("answering optional warnings question advances pipeline", async () => {
			const { orch, engine, cli } = makeSetupOrchestrator({
				passed: true,
				checks: [{ name: "Gitignore: specs/", passed: false, error: "missing", required: false }],
				requiredFailures: [],
				optionalWarnings: [
					{ name: "Gitignore: specs/", passed: false, error: "missing", required: false },
				],
			});

			await orch.startPipeline("test", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 0));

			const wf = getWf(engine);
			expect(wf.steps[0].status).toBe("waiting_for_input");

			// Answer to skip
			expect(wf.pendingQuestion).toBeDefined();
			const questionId = wf.pendingQuestion?.id ?? "";
			orch.answerQuestion(wf.id, questionId, "skip");

			await new Promise((r) => setTimeout(r, 0));

			expect(wf.steps[0].status).toBe("completed");
			expect(wf.currentStepIndex).toBe(1);
			expect(wf.steps[1].status).toBe("running");
			expect(cli._startCalls.length).toBe(1);
		});

		test("runSetupChecks rejection sets step to error", async () => {
			const localEngine = createFakeEngine();
			const localCli = createFakeCliRunner();
			const localCallbacks = makeCallbacks();
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fakes
			const deps: Record<string, any> = {
				engine: localEngine,
				cliRunner: localCli,
				questionDetector: createFakeQuestionDetector(),
				reviewClassifier: createFakeReviewClassifier(),
				summarizer: createFakeSummarizer(),
				auditLogger: createFakeAuditLogger(),
				workflowStore: createFakeWorkflowStore(),
				runSetupChecks: async () => {
					throw new Error("Spawn failed");
				},
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
			};
			const orch = new PipelineOrchestrator(localCallbacks, deps);

			await orch.startPipeline("test", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 0));

			const wf = getWf(localEngine);
			expect(wf.steps[0].name).toBe("setup");
			expect(wf.steps[0].status).toBe("error");
			expect(wf.steps[0].error).toContain("Spawn failed");
			expect(wf.status).toBe("error");
		});

		test("all pass with no warnings auto-advances to specify", async () => {
			const { orch, engine } = makeSetupOrchestrator({
				passed: true,
				checks: [{ name: "Git installed", passed: true, required: true }],
				requiredFailures: [],
				optionalWarnings: [],
			});

			await orch.startPipeline("test", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 0));

			const wf = getWf(engine);
			expect(wf.steps[0].status).toBe("completed");
			expect(wf.currentStepIndex).toBe(1);
			expect(wf.steps[1].name).toBe("specify");
			expect(wf.steps[1].status).toBe("running");
		});

		test("setup pass creates worktree before checkoutMaster", async () => {
			let checkoutCwd: string | undefined;
			const localEngine = createFakeEngine();
			const localCli = createFakeCliRunner();
			const localCallbacks = makeCallbacks();
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fakes
			const deps: Record<string, any> = {
				engine: localEngine,
				cliRunner: localCli,
				questionDetector: createFakeQuestionDetector(),
				reviewClassifier: createFakeReviewClassifier(),
				summarizer: createFakeSummarizer(),
				auditLogger: createFakeAuditLogger(),
				workflowStore: createFakeWorkflowStore(),
				runSetupChecks: async () => ({
					passed: true,
					checks: [],
					requiredFailures: [],
					optionalWarnings: [],
				}),
				checkoutMaster: async (cwd: string) => {
					checkoutCwd = cwd;
					return { code: 0, stderr: "" };
				},
			};
			const orch = new PipelineOrchestrator(localCallbacks, deps);

			await orch.startPipeline("test", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 0));

			const wf = getWf(localEngine);
			expect(wf.worktreePath).toBe("/tmp/test-worktree");
			expect(checkoutCwd).toBe("/tmp/test-worktree");
		});

		test("setup failure does not create worktree", async () => {
			const { orch, engine } = makeSetupOrchestrator({
				passed: false,
				checks: [{ name: "Git repo", passed: false, error: "Not a git repo", required: true }],
				requiredFailures: [
					{ name: "Git repo", passed: false, error: "Not a git repo", required: true },
				],
				optionalWarnings: [],
			});

			await orch.startPipeline("test", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 0));

			const wf = getWf(engine);
			expect(wf.worktreePath).toBeNull();
			expect(wf.status).toBe("error");
		});

		test("setup warnings creates worktree after user answers skip", async () => {
			const { orch, engine } = makeSetupOrchestrator({
				passed: true,
				checks: [{ name: "Gitignore", passed: false, error: "missing entry", required: false }],
				requiredFailures: [],
				optionalWarnings: [
					{ name: "Gitignore", passed: false, error: "missing entry", required: false },
				],
			});

			await orch.startPipeline("test", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 0));

			const wf = getWf(engine);
			expect(wf.worktreePath).toBeNull();

			const questionId = wf.pendingQuestion?.id ?? "";
			orch.answerQuestion(wf.id, questionId, "skip");
			await new Promise((r) => setTimeout(r, 0));

			expect(wf.worktreePath).toBe("/tmp/test-worktree");
			expect(wf.steps[0].status).toBe("completed");
		});

		test("retry after setup failure re-runs checks and creates worktree on pass", async () => {
			let setupCallCount = 0;
			const localEngine = createFakeEngine();
			const localCli = createFakeCliRunner();
			const localCallbacks = makeCallbacks();
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fakes
			const deps: Record<string, any> = {
				engine: localEngine,
				cliRunner: localCli,
				questionDetector: createFakeQuestionDetector(),
				reviewClassifier: createFakeReviewClassifier(),
				summarizer: createFakeSummarizer(),
				auditLogger: createFakeAuditLogger(),
				workflowStore: createFakeWorkflowStore(),
				runSetupChecks: async (): Promise<SetupResult> => {
					setupCallCount++;
					if (setupCallCount === 1) {
						return {
							passed: false,
							checks: [{ name: "Git repo", passed: false, error: "fail", required: true }],
							requiredFailures: [
								{ name: "Git repo", passed: false, error: "fail", required: true },
							],
							optionalWarnings: [],
						};
					}
					return {
						passed: true,
						checks: [],
						requiredFailures: [],
						optionalWarnings: [],
					};
				},
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
			};
			const orch = new PipelineOrchestrator(localCallbacks, deps);

			await orch.startPipeline("test", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 0));

			const wf = getWf(localEngine);
			expect(wf.worktreePath).toBeNull();
			expect(wf.status).toBe("error");

			await orch.retryStep(wf.id);
			await new Promise((r) => setTimeout(r, 0));

			expect(wf.worktreePath).toBe("/tmp/test-worktree");
			expect(wf.steps[0].status).toBe("completed");
		});

		test("createWorktree failure during setup transitions to error", async () => {
			const localEngine = createFakeEngine();
			localEngine.createWorktree = async () => {
				throw new Error("git worktree add failed: already exists");
			};
			const localCallbacks = makeCallbacks();
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fakes
			const deps: Record<string, any> = {
				engine: localEngine,
				cliRunner: createFakeCliRunner(),
				questionDetector: createFakeQuestionDetector(),
				reviewClassifier: createFakeReviewClassifier(),
				summarizer: createFakeSummarizer(),
				auditLogger: createFakeAuditLogger(),
				workflowStore: createFakeWorkflowStore(),
				runSetupChecks: async () => ({
					passed: true,
					checks: [],
					requiredFailures: [],
					optionalWarnings: [],
				}),
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
			};
			const orch = new PipelineOrchestrator(localCallbacks, deps);

			await orch.startPipeline("test", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 0));

			const wf = getWf(localEngine);
			expect(wf.status).toBe("error");
			expect(wf.steps[0].error).toContain("git worktree add failed");
			expect(wf.worktreePath).toBeNull();
		});

		test("copyGitignoredFiles failure cleans up worktree and transitions to error", async () => {
			const localEngine = createFakeEngine();
			let removeWorktreeCalled = false;
			localEngine.copyGitignoredFiles = async () => {
				throw new Error("EACCES: permission denied");
			};
			localEngine.removeWorktree = async () => {
				removeWorktreeCalled = true;
			};
			const localCallbacks = makeCallbacks();
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fakes
			const deps: Record<string, any> = {
				engine: localEngine,
				cliRunner: createFakeCliRunner(),
				questionDetector: createFakeQuestionDetector(),
				reviewClassifier: createFakeReviewClassifier(),
				summarizer: createFakeSummarizer(),
				auditLogger: createFakeAuditLogger(),
				workflowStore: createFakeWorkflowStore(),
				runSetupChecks: async () => ({
					passed: true,
					checks: [],
					requiredFailures: [],
					optionalWarnings: [],
				}),
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
			};
			const orch = new PipelineOrchestrator(localCallbacks, deps);

			await orch.startPipeline("test", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 0));

			const wf = getWf(localEngine);
			expect(wf.status).toBe("error");
			expect(wf.steps[0].error).toContain("EACCES: permission denied");
			expect(wf.worktreePath).toBeNull();
			expect(removeWorktreeCalled).toBe(true);
		});

		test("runSetup passes targetDir not worktreePath to checks", async () => {
			let capturedDir: string | undefined;
			const localEngine = createFakeEngine();
			const localCallbacks = makeCallbacks();
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fakes
			const deps: Record<string, any> = {
				engine: localEngine,
				cliRunner: createFakeCliRunner(),
				questionDetector: createFakeQuestionDetector(),
				reviewClassifier: createFakeReviewClassifier(),
				summarizer: createFakeSummarizer(),
				auditLogger: createFakeAuditLogger(),
				workflowStore: createFakeWorkflowStore(),
				runSetupChecks: async (dir: string) => {
					capturedDir = dir;
					return {
						passed: true,
						checks: [],
						requiredFailures: [],
						optionalWarnings: [],
					};
				},
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
			};
			const orch = new PipelineOrchestrator(localCallbacks, deps);

			await orch.startPipeline("test", "/my/target/repo");
			await new Promise((r) => setTimeout(r, 0));

			expect(capturedDir).toBe("/my/target/repo");
		});
	});

	// T008: Pause-before-merge tests are in ci-pipeline-routing.test.ts
	// where the CI monitor mock is available to properly route to merge-pr

	// T009: pauseForQuestion auto-answer behavior
	describe("pauseForQuestion auto-answer modes", () => {
		test("auto-answers questions in full-auto mode", async () => {
			configStore.save({ autoMode: "full-auto" });
			await startAndFlush("test");
			const wf = getWf(engine);

			const question: Question = {
				id: "q-auto",
				content: "Pick a framework?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			// In full-auto, the question should be auto-answered, not pending
			expect(wf.status).not.toBe("waiting_for_input");
		});

		test("does NOT auto-answer questions in normal mode", async () => {
			configStore.save({ autoMode: "normal" });
			await startAndFlush("test");
			const wf = getWf(engine);

			const question: Question = {
				id: "q-normal",
				content: "Pick a framework?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.status).toBe("waiting_for_input");
			expect(wf.pendingQuestion?.id).toBe("q-normal");
		});

		test("does NOT auto-answer questions in manual mode", async () => {
			configStore.save({ autoMode: "manual" });
			await startAndFlush("test");
			const wf = getWf(engine);

			const question: Question = {
				id: "q-manual",
				content: "Pick a framework?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.status).toBe("waiting_for_input");
			expect(wf.pendingQuestion?.id).toBe("q-manual");
		});
	});
});
