import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { getStepDefinitionsForKind } from "../src/types";

// ── Fake dependencies (no mock.module — uses DI) ──────────────────────

function createFakeEngine() {
	let workflow: Workflow | null = null;

	return {
		getWorkflow: () => workflow,
		createWorkflow: async (spec: string, targetRepository: string) => {
			const now = new Date().toISOString();
			workflow = {
				id: "test-wf-id",
				workflowKind: "spec",
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
				steps: getStepDefinitionsForKind("spec").map((def) => ({
					name: def.name,
					displayName: def.displayName,
					status: "pending" as const,
					prompt: def.name === "specify" ? `${def.prompt} ${spec}` : def.prompt,
					sessionId: null,
					output: "",
					outputLog: [],
					error: null,
					startedAt: null,
					completedAt: null,
					pid: null,
					history: [],
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
				feedbackEntries: [],
				feedbackPreRunHead: null,
				activeInvocation: null,
				managedRepo: null,
				error: null,
				hasEverStarted: false,
				createdAt: now,
				updatedAt: now,
				archived: false,
				archivedAt: null,
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
	let hasFinalized = false;
	// When `gateOnFinalized` is true, detectFromFinalized only returns a
	// pushed result after appendFinalizedMessage has been called. This
	// mirrors the real detector's partial-vs-finalized contract and is the
	// mode the orchestrator wiring tests opt into. Defaults to false so
	// older tests that push a result and call `onComplete()` directly still
	// observe detection without having to wire an assistant message too.
	let gateOnFinalized = false;
	return {
		appendFinalizedMessage: (_text: string) => {
			hasFinalized = true;
		},
		detectFromFinalized: (): Question | null => {
			if (gateOnFinalized && !hasFinalized) return null;
			return detectResults.shift() ?? null;
		},
		classifyWithHaiku: mock((_text: string) => Promise.resolve(false)),
		reset: mock(() => {
			hasFinalized = false;
		}),
		_pushDetectResult: (r: Question | null) => detectResults.push(r),
		_enableFinalizedGating: () => {
			gateOnFinalized = true;
		},
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
		logArtifactsStart: mock((_runId: string, _payload: Record<string, unknown>) => {}),
		logArtifactsEnd: mock((_runId: string, _payload: Record<string, unknown>) => {}),
	};
}

function createFakeWorkflowStore() {
	return {
		save: mock(async () => {}),
		load: mock(async () => null),
		loadAll: mock(async (): Promise<Workflow[]> => []),
		loadIndex: mock(async () => []),
		remove: mock(async () => {}),
		waitForPendingWrites: mock(async () => {}),
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
		onAlertEmit: mock(() => {}),
		onAlertMarkSeenWhere: mock(() => {}),
	};
}

/** Get the mock workflow, throwing if null (avoids non-null assertions in tests) */
function getWf(eng: ReturnType<typeof createFakeEngine>): Workflow {
	const wf = eng._getWorkflow();
	if (!wf) throw new Error("Expected workflow to exist");
	return wf;
}

/**
 * Seed an empty manifest in the artifacts-output dir so that when the CLI
 * stub's onComplete is called for the artifacts step, collection succeeds
 * with outcome=empty and the orchestrator advances to commit-push-pr.
 * Idempotent: safe to call even if the directory already exists.
 */
function seedEmptyArtifactsManifest(wf: Workflow): void {
	const branch = wf.featureBranch ?? wf.worktreeBranch;
	const worktreePath = wf.worktreePath ?? "/tmp/test-worktree";
	const outputDir = join(worktreePath, "specs", branch, "artifacts-output");
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(join(outputDir, "manifest.json"), JSON.stringify({ version: 1, artifacts: [] }));
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
	let detectNewCommitsResult: string[] = [];

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
		detectNewCommitsResult = [];

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
			ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
			checkoutMaster: async () => ({ code: 0, stderr: "" }),
			getGitHead: async () => "pre-run-head-sha",
			detectNewCommits: async () => detectNewCommitsResult,
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

		test("pipeline has 15 steps in correct order", async () => {
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
				"artifacts",
				"commit-push-pr",
				"monitor-ci",
				"fix-ci",
				"feedback-implementer",
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

			// implement-review (7) completes → classify as minor → advance to artifacts (8)
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(8);
			expect(wf.steps[8].name).toBe("artifacts");

			// artifacts (8) completes → empty manifest → advance to commit-push-pr (9)
			seedEmptyArtifactsManifest(wf);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(9);
			expect(wf.steps[9].name).toBe("commit-push-pr");

			// commit-push-pr (9) completes → routes to monitor-ci (10)
			// monitor-ci tries to discover PR URL asynchronously, then errors
			cli.getLastCallbacks().onComplete();

			expect(wf.currentStepIndex).toBe(10);
			expect(wf.steps[10].name).toBe("monitor-ci");

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

		test("partial-only deltas without a finalized assistant message do NOT pause", async () => {
			// Regression guard for FR-008, FR-009: handleStepComplete must
			// run detection through detectFromFinalized(), and the orchestrator
			// must only forward finalized `assistant` events (not partial
			// content_block_delta fragments) into the detector via
			// appendFinalizedMessage. If either contract breaks, this test
			// regresses because the detector will never see a finalized message
			// and detection yields null — so the step must advance.
			qd._enableFinalizedGating();
			await startAndFlush("test");
			const wf = getWf(engine);

			const question: Question = {
				id: "q1",
				content: "Would you like to proceed?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			// Stream partial deltas only — no onAssistantMessage.
			cli.getLastCallbacks().onOutput("Would ");
			cli.getLastCallbacks().onOutput("you like ");
			cli.getLastCallbacks().onOutput("to proceed?");

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.steps[1].status).toBe("completed");
			expect(wf.currentStepIndex).toBe(2);
			expect(wf.pendingQuestion).toBeNull();
		});

		test("finalized assistant message triggers pause when orchestrator forwards it", async () => {
			// Complement of the partial-only test: when the fake CLI emits a
			// finalized `assistant` event, the orchestrator must forward it via
			// appendFinalizedMessage so detection fires on completion.
			qd._enableFinalizedGating();
			await startAndFlush("test");
			const wf = getWf(engine);

			const question: Question = {
				id: "q1",
				content: "Would you like to proceed?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			const finalCallbacks = cli.getLastCallbacks();
			finalCallbacks.onOutput("Would you like to proceed?");
			finalCallbacks.onAssistantMessage?.("Would you like to proceed?");
			finalCallbacks.onComplete();
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

			// Review completes → always goes to implement-review. The
			// iteration counter stays on the current review (it is only
			// bumped when the cycle loops back for another review).
			cli.getLastCallbacks().onComplete();

			expect(wf.reviewCycle.iteration).toBe(1);
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

		test("stops cycling on minor severity → advances to artifacts", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(8);
			expect(wf.steps[8].name).toBe("artifacts");
		});

		test("stops cycling on trivial severity", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("trivial");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(8);
			expect(wf.steps[8].name).toBe("artifacts");
		});

		test("stops cycling on nit severity", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("nit");
			cli.getLastCallbacks().onComplete(); // implement-review → classify
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(8);
			expect(wf.steps[8].name).toBe("artifacts");
		});

		test("caps review cycling at maxIterations", async () => {
			await advanceToReview();
			const wf = getWf(engine);

			wf.reviewCycle.iteration = 16;

			// Review → implement-review (iteration stays at 16 — it only
			// bumps when we actually loop back for another review).
			cli.getLastCallbacks().onComplete();

			// implement-review completes → classify as critical but capped
			rc._pushClassifyResult("critical");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(8); // artifacts despite critical
			expect(wf.steps[8].name).toBe("artifacts");
			expect(wf.reviewCycle.iteration).toBe(16);
		});
	});

	// T003: Spec summary preservation — maybeSummarize writes to stepSummary, not summary
	describe("spec summary preservation", () => {
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

			// First review completes → always routes to implement-review.
			// iteration stays at 1 until the cycle actually loops back.
			cli.getLastCallbacks().onComplete();

			expect(wf.reviewCycle.iteration).toBe(1);
			expect(wf.currentStepIndex).toBe(7); // implement-review
			expect(wf.steps[7].status).toBe("running");

			// implement-review completes → classify as critical → loop back to
			// review. The loop-back bumps iteration to 2 so the next review
			// runs under its own ordinal.
			rc._pushClassifyResult("critical");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.reviewCycle.lastSeverity).toBe("critical");
			expect(wf.reviewCycle.iteration).toBe(2);
			expect(wf.currentStepIndex).toBe(6); // review again
			expect(wf.steps[6].status).toBe("running");

			// Second review completes → implement-review again. iteration
			// stays at 2 — no bump on the review → implement-review hop.
			cli.getLastCallbacks().onComplete();

			expect(wf.reviewCycle.iteration).toBe(2);
			expect(wf.currentStepIndex).toBe(7); // implement-review
			expect(wf.steps[7].status).toBe("running");

			// implement-review completes → classify as minor → advance to artifacts
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.reviewCycle.lastSeverity).toBe("minor");
			expect(wf.currentStepIndex).toBe(8); // artifacts
			expect(wf.steps[8].name).toBe("artifacts");

			// artifacts completes with an empty manifest → advance to commit-push-pr
			seedEmptyArtifactsManifest(wf);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.currentStepIndex).toBe(9); // commit-push-pr
			expect(wf.steps[9].name).toBe("commit-push-pr");

			// commit-push-pr completes → routes to monitor-ci
			// monitor-ci tries to discover PR URL asynchronously, then errors
			cli.getLastCallbacks().onComplete();

			expect(wf.currentStepIndex).toBe(10);
			expect(wf.steps[10].name).toBe("monitor-ci");

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
			const wf = await startAndFlush("test");

			// Complete steps 1–5 (specify → implement); setup (0) already completed
			for (let i = 0; i < 5; i++) {
				cli.getLastCallbacks().onComplete();
			}

			// Review → implement-review → minor → artifacts → commit-push-pr
			cli.getLastCallbacks().onComplete(); // review → implement-review
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete(); // implement-review → classify → artifacts
			await new Promise((r) => setTimeout(r, 20));

			// artifacts completes with empty manifest → advances to commit-push-pr
			seedEmptyArtifactsManifest(wf);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			// commit-push-pr completes → monitor-ci tries to discover PR URL, then errors
			cli.getLastCallbacks().onComplete();

			// Wait for async PR URL discovery to fail
			await new Promise((r) => setTimeout(r, 200));

			expect(auditLogger.endRun).toHaveBeenCalledTimes(1);
			expect(auditLogger.endRun.mock.calls[0][0]).toBe("fake-audit-run-id");
		});

		test("abortPipeline calls auditLogger.endRun with aborted metadata", async () => {
			await startAndFlush("test");

			orchestrator.abortPipeline("test-wf-id");

			expect(auditLogger.endRun).toHaveBeenCalledWith("fake-audit-run-id", { aborted: true });
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
	describe("abort", () => {
		test("abortPipeline kills CLI process and sets aborted state", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			orchestrator.abortPipeline("test-wf-id");

			expect(cli.kill).toHaveBeenCalledWith("test-wf-id");
			expect(wf.status).toBe("aborted");
			expect(wf.steps[1].status).toBe("error");
			expect(wf.steps[1].error).toBe("Aborted by user");
		});

		test("abortPipeline triggers epic dependency check when epicId is set", async () => {
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

			orchestrator.abortPipeline("test-wf-id");

			expect(wf.status).toBe("aborted");
			// checkEpicDependencies is async — give it a tick
			await new Promise((r) => setTimeout(r, 50));
			expect(callbacks.onEpicDependencyUpdate).toHaveBeenCalledWith("sibling-wf", "blocked", [
				wf.id,
			]);
		});

		test("abort during Q&A sets aborted state", async () => {
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

			orchestrator.abortPipeline("test-wf-id");

			expect(wf.status).toBe("aborted");
			const markSeen = callbacks.onAlertMarkSeenWhere as unknown as {
				mock: { calls: unknown[][] };
			};
			const marked = markSeen.mock.calls.some((c) => {
				const pred = c[0] as (a: { type: string; workflowId?: string }) => boolean;
				return pred({ type: "question-asked", workflowId: "test-wf-id" });
			});
			expect(marked).toBe(true);
		});
	});

	describe("epic dependency resolution", () => {
		test("abort resolves satisfied for sibling whose deps are all completed", async () => {
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
			orchestrator.abortPipeline("test-wf-id");

			await new Promise((r) => setTimeout(r, 50));
			expect(callbacks.onEpicDependencyUpdate).toHaveBeenCalledWith("sibling-wf", "satisfied", []);
		});

		test("abort notifies sibling with blocked status", async () => {
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
			// wf appears as aborted in the store after abortPipeline
			const abortedWf = { ...wf, status: "aborted" as const };
			store.loadAll = mock(async () => [abortedWf, sibling]);
			store.save = mock(async () => {});

			orchestrator.abortPipeline("test-wf-id");

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

			orchestrator.abortPipeline("test-wf-id");

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

		test("abort from paused: abortPipeline sets step to error and workflow to aborted", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			wf.steps[1].sessionId = "test-session-123";
			orchestrator.pause("test-wf-id");

			expect(wf.status).toBe("paused");
			expect(wf.steps[1].status).toBe("paused");

			orchestrator.abortPipeline("test-wf-id");

			expect(wf.steps[1].status).toBe("error");
			expect(wf.steps[1].error).toBe("Aborted by user");
			expect(wf.status).toBe("aborted");
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

		test("pause during in-flight classifyWithHaiku does not advance paused workflow", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);

			// Arrange: the current step will look like a question candidate, but classify
			// returns a controllable deferred promise so we can pause mid-flight.
			const question: Question = {
				id: "q1",
				content: "Does this compile?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);

			let resolveClassify: ((v: boolean) => void) | null = null;
			qd.classifyWithHaiku.mockImplementationOnce(
				() =>
					new Promise<boolean>((resolve) => {
						resolveClassify = resolve;
					}),
			);

			// CLI completes → handleStepComplete starts classifyWithHaiku
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 0));

			// User pauses before classify resolves
			orchestrator.pause("test-wf-id");
			expect(wf.status).toBe("paused");
			const pausedStepIndex = wf.currentStepIndex;
			const startCallsBeforeClassify = cli._startCalls.length;

			// Classify resolves as "not a question" → would previously advance
			if (!resolveClassify) throw new Error("classify promise not captured");
			(resolveClassify as (v: boolean) => void)(false);
			await new Promise((r) => setTimeout(r, 20));

			// Assert: workflow stays paused, no new CLI started, step index unchanged
			expect(wf.status).toBe("paused");
			expect(wf.currentStepIndex).toBe(pausedStepIndex);
			expect(cli._startCalls.length).toBe(startCallsBeforeClassify);
		});

		// Seeds a workflow paused at merge-pr so we can exercise runMergePr via resume().
		async function seedAtMergePrPaused(o: PipelineOrchestrator): Promise<Workflow> {
			await o.startPipeline("test", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 0));
			const wf = getWf(engine);
			wf.prUrl = "https://github.com/owner/repo/pull/42";
			wf.worktreePath = "/tmp/test-worktree";
			wf.summary = "test summary";
			const mergeIdx = wf.steps.findIndex((s) => s.name === "merge-pr");
			for (let i = 0; i < mergeIdx; i++) wf.steps[i].status = "completed";
			wf.currentStepIndex = mergeIdx;
			wf.steps[mergeIdx].status = "paused";
			wf.status = "paused";
			return wf;
		}

		test("pause during in-flight mergePr discards the merge result (no CI restart)", async () => {
			// Race scenario: the user clicks Pause while mergePr is still awaiting.
			// When mergePr later resolves with a conflict, handleMergeResult must NOT
			// start conflict resolution or route back to monitor-ci — otherwise a fresh
			// CI-polling session spins up that pause() no longer has a handle to.
			const mergeDeferred = Promise.withResolvers<{
				merged: boolean;
				alreadyMerged: boolean;
				conflict: boolean;
				error?: string;
			}>();
			const mergePrFn = mock(() => mergeDeferred.promise);
			const resolveConflictsFn = mock(async () => {});

			// biome-ignore lint/suspicious/noExplicitAny: test DI
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
				getGitHead: async () => "pre-run-head-sha",
				detectNewCommits: async () => detectNewCommitsResult,
				mergePr: mergePrFn,
				resolveConflicts: resolveConflictsFn,
			};
			orchestrator = new PipelineOrchestrator(callbacks, deps);

			const wf = await seedAtMergePrPaused(orchestrator);
			const mergeIdx = wf.currentStepIndex;

			// Resume triggers runMergePr → mergePrFn (deferred, in-flight)
			orchestrator.resume(wf.id);
			await new Promise((r) => setTimeout(r, 0));
			expect(mergePrFn).toHaveBeenCalledTimes(1);
			expect(wf.status).toBe("running");

			// User pauses while merge is still pending
			orchestrator.pause(wf.id);
			expect(wf.status).toBe("paused");
			const attemptBefore = wf.mergeCycle.attempt;
			const monitorStartedAtBefore = wf.ciCycle.monitorStartedAt;

			// Merge eventually reports a conflict
			mergeDeferred.resolve({ merged: false, alreadyMerged: false, conflict: true });
			await new Promise((r) => setTimeout(r, 20));

			// Nothing further should have happened: no conflict resolution, no route back,
			// no fresh CI monitoring.
			expect(resolveConflictsFn).not.toHaveBeenCalled();
			expect(wf.status).toBe("paused");
			expect(wf.currentStepIndex).toBe(mergeIdx);
			expect(wf.mergeCycle.attempt).toBe(attemptBefore);
			expect(wf.ciCycle.monitorStartedAt).toBe(monitorStartedAtBefore);
		});

		test("pause during in-flight conflict resolution does not route back to monitor-ci", async () => {
			// Race scenario: mergePr resolves with a conflict while the workflow is still
			// running, so resolveConflicts starts. The user then pauses. When conflict
			// resolution resolves, the .then() must re-check workflow status and NOT
			// call routeBackToMonitor — this is the exact path that previously restarted
			// CI polling behind a paused workflow.
			const conflictDeferred = Promise.withResolvers<void>();
			const mergePrFn = mock(async () => ({
				merged: false,
				alreadyMerged: false,
				conflict: true,
			}));
			const resolveConflictsFn = mock(() => conflictDeferred.promise);

			// biome-ignore lint/suspicious/noExplicitAny: test DI
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
				getGitHead: async () => "pre-run-head-sha",
				detectNewCommits: async () => detectNewCommitsResult,
				mergePr: mergePrFn,
				resolveConflicts: resolveConflictsFn,
			};
			orchestrator = new PipelineOrchestrator(callbacks, deps);

			const wf = await seedAtMergePrPaused(orchestrator);
			const mergeIdx = wf.currentStepIndex;

			// Resume → mergePr resolves with conflict → resolveConflicts starts (in-flight)
			orchestrator.resume(wf.id);
			await new Promise((r) => setTimeout(r, 20));
			expect(resolveConflictsFn).toHaveBeenCalledTimes(1);
			expect(wf.status).toBe("running");

			// User pauses while conflict resolution is still in-flight
			orchestrator.pause(wf.id);
			expect(wf.status).toBe("paused");
			const attemptBefore = wf.mergeCycle.attempt;
			const monitorStartedAtBefore = wf.ciCycle.monitorStartedAt;

			// Conflict resolution finally resolves
			conflictDeferred.resolve();
			await new Promise((r) => setTimeout(r, 20));

			// Must stay paused at merge-pr, with no routing back to monitor-ci.
			expect(wf.status).toBe("paused");
			expect(wf.currentStepIndex).toBe(mergeIdx);
			expect(wf.mergeCycle.attempt).toBe(attemptBefore);
			expect(wf.ciCycle.monitorStartedAt).toBe(monitorStartedAtBefore);
		});

		test("pause during in-flight discoverPrUrl does not start CI monitoring", async () => {
			// Race scenario: monitor-ci has no prUrl yet, so runMonitorCi calls
			// discoverPrUrl. The user pauses while the lookup is in-flight. When
			// discoverPrUrl later resolves with a URL, the .then() must re-check
			// workflow status and NOT call startCiMonitoring — otherwise a fresh
			// AbortController is minted that pause() no longer has a handle to.
			const discoverDeferred = Promise.withResolvers<string | null>();
			const discoverPrUrlFn = mock(() => discoverDeferred.promise);

			// biome-ignore lint/suspicious/noExplicitAny: test DI
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
				getGitHead: async () => "pre-run-head-sha",
				detectNewCommits: async () => detectNewCommitsResult,
				discoverPrUrl: discoverPrUrlFn,
			};
			orchestrator = new PipelineOrchestrator(callbacks, deps);

			// Seed at monitor-ci paused, with no prUrl so runMonitorCi takes the
			// discovery path on resume. Wrapped in an IIFE-returning helper so the
			// narrowed "paused" literal type on `status` widens back to WorkflowStatus
			// before we later assert it becomes "running".
			const seed = async (): Promise<Workflow> => {
				await orchestrator.startPipeline("test", "/tmp/test-repo");
				await new Promise((r) => setTimeout(r, 0));
				const w = getWf(engine);
				w.worktreePath = "/tmp/test-worktree";
				w.summary = "test summary";
				w.prUrl = null;
				const mi = w.steps.findIndex((s) => s.name === "monitor-ci");
				for (let i = 0; i < mi; i++) w.steps[i].status = "completed";
				w.currentStepIndex = mi;
				w.steps[mi].status = "paused";
				w.status = "paused";
				return w;
			};
			const wf = await seed();
			const monitorIdx = wf.currentStepIndex;

			// Resume → runMonitorCi → discoverPrUrl (deferred, in-flight)
			orchestrator.resume(wf.id);
			await new Promise((r) => setTimeout(r, 0));
			expect(discoverPrUrlFn).toHaveBeenCalledTimes(1);
			expect(wf.status).toBe("running");

			// User pauses while discovery is still pending
			orchestrator.pause(wf.id);
			expect(wf.status).toBe("paused");
			const monitorStartedAtBefore = wf.ciCycle.monitorStartedAt;

			// Discovery finally resolves with a URL
			discoverDeferred.resolve("https://github.com/owner/repo/pull/99");
			await new Promise((r) => setTimeout(r, 20));

			// Must stay paused; no prUrl assignment, no CI monitoring kicked off.
			expect(wf.status).toBe("paused");
			expect(wf.currentStepIndex).toBe(monitorIdx);
			expect(wf.prUrl).toBeNull();
			expect(wf.ciCycle.monitorStartedAt).toBe(monitorStartedAtBefore);
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
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

	describe("manual-mode feedback loop", () => {
		const PR_URL = "https://github.com/owner/repo/pull/1";

		async function seedMergePrPause(): Promise<Workflow> {
			configStore.save({ autoMode: "manual" });
			await startAndFlush("test");
			const wf = getWf(engine);
			wf.prUrl = PR_URL;
			wf.worktreePath = "/tmp/test-worktree";
			const mergeIdx = wf.steps.findIndex((s) => s.name === "merge-pr");
			// Complete preceding steps cosmetically for realism
			for (let i = 0; i < mergeIdx; i++) {
				wf.steps[i].status = "completed";
			}
			wf.currentStepIndex = mergeIdx;
			wf.steps[mergeIdx].status = "paused";
			wf.status = "paused";
			return wf;
		}

		test("submitFeedback appends entry, transitions running, starts feedback-implementer", async () => {
			const wf = await seedMergePrPause();
			const cliCountBefore = cli._startCalls.length;

			orchestrator.submitFeedback(wf.id, "rename x to count");
			await new Promise((r) => setTimeout(r, 10));

			expect(wf.feedbackEntries).toHaveLength(1);
			expect(wf.feedbackEntries[0].text).toBe("rename x to count");
			expect(wf.feedbackEntries[0].iteration).toBe(1);
			expect(wf.feedbackEntries[0].outcome).toBeNull();
			expect(wf.status).toBe("running");

			const fiIdx = wf.steps.findIndex((s) => s.name === "feedback-implementer");
			expect(wf.currentStepIndex).toBe(fiIdx);

			const cliCall = cli._startCalls[cli._startCalls.length - 1];
			expect(cli._startCalls.length).toBeGreaterThan(cliCountBefore);
			expect(cliCall.workflow.specification).toContain("rename x to count");
			expect(cliCall.workflow.specification).toContain(PR_URL);
		});

		test("submitFeedback with whitespace-only text behaves like Resume (FR-014)", async () => {
			const wf = await seedMergePrPause();

			orchestrator.submitFeedback(wf.id, "   \n\t  ");
			await new Promise((r) => setTimeout(r, 10));

			expect(wf.feedbackEntries).toHaveLength(0);
			// resume() for merge-pr calls runMergePr → mergePrFn. We didn't mock mergePrFn,
			// so it will fail asynchronously. Just check state transitioned to running.
			expect(wf.status === "running" || wf.status === "error").toBe(true);
		});

		test("submitFeedback rejects when an in-flight entry exists (FR-016)", async () => {
			const wf = await seedMergePrPause();
			wf.feedbackEntries = [
				{
					id: "fe-inflight",
					iteration: 1,
					text: "previous",
					submittedAt: new Date().toISOString(),
					submittedAtStepName: "merge-pr",
					outcome: null,
				},
			];

			orchestrator.submitFeedback(wf.id, "new one");
			await new Promise((r) => setTimeout(r, 10));

			expect(wf.feedbackEntries).toHaveLength(1);
			expect(wf.feedbackEntries[0].text).toBe("previous");
			expect(wf.status).toBe("paused");
		});

		test("feedback-implementer success with commits routes to monitor-ci", async () => {
			const wf = await seedMergePrPause();
			detectNewCommitsResult = ["commit-abc"];

			orchestrator.submitFeedback(wf.id, "rename x to count");
			await new Promise((r) => setTimeout(r, 10));

			// Simulate agent emitting a sentinel + completing
			const sentinel = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"renamed","materiallyRelevant":true}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
			cli.getLastCallbacks().onOutput(sentinel);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 30));

			const entry = wf.feedbackEntries[0];
			expect(entry.outcome).not.toBeNull();
			expect(entry.outcome?.value).toBe("success");
			expect(entry.outcome?.commitRefs).toEqual(["commit-abc"]);

			const monIdx = wf.steps.findIndex((s) => s.name === "monitor-ci");
			expect(wf.currentStepIndex).toBe(monIdx);
		});

		test("feedback-implementer no-changes outcome rewinds to merge-pr paused", async () => {
			const wf = await seedMergePrPause();
			detectNewCommitsResult = [];

			orchestrator.submitFeedback(wf.id, "already done");
			await new Promise((r) => setTimeout(r, 10));

			const sentinel = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"no changes","summary":"already done","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
			cli.getLastCallbacks().onOutput(sentinel);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 30));

			const entry = wf.feedbackEntries[0];
			expect(entry.outcome?.value).toBe("no changes");

			const mergeIdx = wf.steps.findIndex((s) => s.name === "merge-pr");
			expect(wf.currentStepIndex).toBe(mergeIdx);
			expect(wf.status).toBe("paused");
			expect(wf.steps[mergeIdx].status).toBe("paused");
		});

		test("feedback-implementer CLI error rewinds to merge-pr paused with failed outcome (FR-012)", async () => {
			const wf = await seedMergePrPause();

			orchestrator.submitFeedback(wf.id, "impossible");
			await new Promise((r) => setTimeout(r, 10));

			cli.getLastCallbacks().onError("agent exploded");
			await new Promise((r) => setTimeout(r, 20));

			const entry = wf.feedbackEntries[0];
			expect(entry.outcome?.value).toBe("failed");
			expect(entry.outcome?.summary).toContain("agent exploded");

			const mergeIdx = wf.steps.findIndex((s) => s.name === "merge-pr");
			expect(wf.currentStepIndex).toBe(mergeIdx);
			expect(wf.status).toBe("paused");

			// FI step status is resolved (not left "running") after error handling.
			const fiIdx = wf.steps.findIndex((s) => s.name === "feedback-implementer");
			expect(wf.steps[fiIdx].status).toBe("error");
			expect(wf.steps[fiIdx].error).toContain("agent exploded");
			expect(wf.steps[fiIdx].pid).toBeNull();
			expect(wf.steps[fiIdx].completedAt).not.toBeNull();
		});

		test("Abort during feedback-implementer sets aborted outcome (FR-019)", async () => {
			const wf = await seedMergePrPause();

			orchestrator.submitFeedback(wf.id, "refactor everything");
			await new Promise((r) => setTimeout(r, 10));

			// Simulate user pausing mid-run
			orchestrator.pause(wf.id);
			expect(wf.status).toBe("paused");

			// Then aborting
			orchestrator.abortPipeline(wf.id);
			await new Promise((r) => setTimeout(r, 10));

			const entry = wf.feedbackEntries[0];
			expect(entry.outcome?.value).toBe("aborted");
			expect(entry.outcome?.summary).toContain("Aborted by user");
			expect(wf.status).toBe("aborted");
		});

		test("pause during submitFeedback→getGitHead await does not spawn CLI", async () => {
			// Race scenario (#1.4): submitFeedback calls runFeedbackImplementer which
			// awaits getGitHead. If the user clicks Pause before the promise resolves,
			// the subsequent runStep should NOT spawn a CLI.
			const pending = Promise.withResolvers<void>();
			const blockingGetGitHead = async (): Promise<string> => {
				await pending.promise;
				return "pre-run-head-sha";
			};
			// biome-ignore lint/suspicious/noExplicitAny: test DI
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
				getGitHead: blockingGetGitHead,
				detectNewCommits: async () => detectNewCommitsResult,
			};
			orchestrator = new PipelineOrchestrator(callbacks, deps);

			const wf = await seedMergePrPause();
			const cliCountBefore = cli._startCalls.length;

			orchestrator.submitFeedback(wf.id, "refactor");
			// submit flipped state to running but getGitHead is still pending.
			await new Promise((r) => setTimeout(r, 10));
			expect(wf.status).toBe("running");

			orchestrator.pause(wf.id);
			expect(wf.status).toBe("paused");

			// Now unblock — runStep should NOT spawn a new CLI because the workflow
			// is paused and the step is paused.
			pending.resolve();
			await new Promise((r) => setTimeout(r, 30));

			expect(cli._startCalls.length).toBe(cliCountBefore);
		});

		test("pause-resume preserves feedbackPreRunHead across a single iteration", async () => {
			// Swap getGitHead for a counting version so we can assert it only ran once
			// across the pause-resume cycle. Must re-instantiate the orchestrator.
			let getGitHeadCalls = 0;
			const countingGetGitHead = async () => {
				getGitHeadCalls++;
				return "pre-run-head-sha";
			};
			// biome-ignore lint/suspicious/noExplicitAny: test DI
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
				getGitHead: countingGetGitHead,
				detectNewCommits: async () => detectNewCommitsResult,
			};
			orchestrator = new PipelineOrchestrator(callbacks, deps);

			const wf = await seedMergePrPause();

			orchestrator.submitFeedback(wf.id, "refactor extensively");
			await new Promise((r) => setTimeout(r, 20));
			expect(getGitHeadCalls).toBe(1);

			// Simulate session ID not yet captured, then pause (no CLI kill matters here).
			orchestrator.pause(wf.id);
			expect(wf.status).toBe("paused");

			orchestrator.resume(wf.id);
			await new Promise((r) => setTimeout(r, 20));

			// Head should have been snapshot only ONCE — preserved across pause-resume.
			expect(getGitHeadCalls).toBe(1);
		});

		test("iteration counter increments across multiple submissions", async () => {
			const wf = await seedMergePrPause();

			orchestrator.submitFeedback(wf.id, "first feedback");
			await new Promise((r) => setTimeout(r, 10));

			// Force a no-changes outcome so we return to merge-pr pause
			const sentinel1 = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"no changes","summary":"","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
			cli.getLastCallbacks().onOutput(sentinel1);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 30));

			expect(wf.status).toBe("paused");

			orchestrator.submitFeedback(wf.id, "second feedback");
			await new Promise((r) => setTimeout(r, 10));

			expect(wf.feedbackEntries).toHaveLength(2);
			expect(wf.feedbackEntries[1].iteration).toBe(2);
		});

		test("CLI prompt includes the prior feedback context for subsequent iterations (FR-010)", async () => {
			const wf = await seedMergePrPause();

			// Manually seed a completed entry as if from a prior iteration
			wf.feedbackEntries = [
				{
					id: "fe-prev",
					iteration: 1,
					text: "earlier feedback",
					submittedAt: new Date().toISOString(),
					submittedAtStepName: "merge-pr",
					outcome: {
						value: "success",
						summary: "earlier change",
						commitRefs: ["prev-abc"],
						warnings: [],
					},
				},
			];

			orchestrator.submitFeedback(wf.id, "newer feedback");
			await new Promise((r) => setTimeout(r, 10));

			const cliCall = cli._startCalls[cli._startCalls.length - 1];
			expect(cliCall.workflow.specification).toContain("USER FEEDBACK");
			expect(cliCall.workflow.specification).toContain("authoritative");
			expect(cliCall.workflow.specification).toContain("earlier feedback");
			expect(cliCall.workflow.specification).toContain("newer feedback");
		});

		test("PR-description update failure after commits lands as success + warning (FR-007, FR-008)", async () => {
			const wf = await seedMergePrPause();
			detectNewCommitsResult = ["commit-landed"];

			orchestrator.submitFeedback(wf.id, "big materially relevant change");
			await new Promise((r) => setTimeout(r, 10));

			const sentinel = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"landed big change","materiallyRelevant":true,"prDescriptionUpdate":{"attempted":true,"succeeded":false,"errorMessage":"gh: rate limited"}}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
			cli.getLastCallbacks().onOutput(sentinel);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 30));

			const entry = wf.feedbackEntries[0];
			expect(entry.outcome?.value).toBe("success");
			expect(entry.outcome?.commitRefs).toEqual(["commit-landed"]);
			expect(entry.outcome?.warnings).toHaveLength(1);
			expect(entry.outcome?.warnings[0].kind).toBe("pr_description_update_failed");
			expect(entry.outcome?.warnings[0].message).toContain("gh: rate limited");

			// Workflow still proceeds to monitor-ci — the PR edit failure is non-fatal
			const monIdx = wf.steps.findIndex((s) => s.name === "monitor-ci");
			expect(wf.currentStepIndex).toBe(monIdx);
		});

		test("runFeedbackImplementer prompt includes Prior outcome records section when prior entries exist (FR-017)", async () => {
			const wf = await seedMergePrPause();

			wf.feedbackEntries = [
				{
					id: "fe-prev",
					iteration: 1,
					text: "earlier feedback",
					submittedAt: new Date().toISOString(),
					submittedAtStepName: "merge-pr",
					outcome: {
						value: "success",
						summary: "first change summary",
						commitRefs: ["prev-abc"],
						warnings: [],
					},
				},
			];

			orchestrator.submitFeedback(wf.id, "newer feedback");
			await new Promise((r) => setTimeout(r, 10));

			const spec = cli._startCalls[cli._startCalls.length - 1].workflow.specification;
			expect(spec).toContain("Prior feedback-implementer outcome records");
			expect(spec).toContain("first change summary");
			expect(spec).toContain("prev-abc");
		});

		test("paused-FI across restart reuses the persisted feedbackPreRunHead", async () => {
			// Scenario (review-2 #1.1): user submits feedback, the agent pushes a
			// commit, user presses Pause, the server restarts before the user
			// resumes. When the workflow is reloaded with feedbackPreRunHead
			// persisted, the fresh orchestrator instance MUST NOT re-snapshot HEAD
			// on resume — otherwise commits pushed before the pause are excluded
			// from commitRefs.
			let getGitHeadCalls = 0;
			const countingGetGitHead = async () => {
				getGitHeadCalls++;
				return "fresh-head-after-restart";
			};
			// biome-ignore lint/suspicious/noExplicitAny: test DI
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
				getGitHead: countingGetGitHead,
				detectNewCommits: async () => detectNewCommitsResult,
			};
			orchestrator = new PipelineOrchestrator(callbacks, deps);

			const wf = await seedMergePrPause();

			// Simulate the pre-restart state: a feedback iteration ran and its
			// pre-run head was persisted on the workflow. The user then paused.
			wf.feedbackPreRunHead = "original-head-before-feedback";
			wf.feedbackEntries.push({
				id: "fe-resumed",
				iteration: 1,
				text: "refactor everything",
				submittedAt: new Date().toISOString(),
				submittedAtStepName: "merge-pr",
				outcome: null,
			});
			const fiIdx = wf.steps.findIndex((s) => s.name === "feedback-implementer");
			wf.currentStepIndex = fiIdx;
			wf.steps[fiIdx].status = "paused";
			wf.status = "paused";

			// Resume — the step has no sessionId, so runFeedbackImplementer is
			// called fresh. It must skip the getGitHead call because the workflow
			// already carries the persisted preRunHead.
			orchestrator.resume(wf.id);
			await new Promise((r) => setTimeout(r, 20));

			expect(getGitHeadCalls).toBe(0);
			expect(wf.feedbackPreRunHead).toBe("original-head-before-feedback");

			// Further: when the iteration completes, detectNewCommits is called
			// with the persisted preRunHead — not the fresh one.
			detectNewCommitsResult = ["commit-from-before-pause"];
			const sentinel = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"done","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
			cli.getLastCallbacks().onOutput(sentinel);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 30));

			expect(wf.feedbackEntries[wf.feedbackEntries.length - 1].outcome?.commitRefs).toEqual([
				"commit-from-before-pause",
			]);
		});

		test("FI output that looks like a question does NOT enter waiting_for_input", async () => {
			// Scenario (review-2 #1.2): the question detector/classifier must be
			// skipped for the feedback-implementer step so agent output that looks
			// question-shaped can't strand the workflow in waiting_for_input (which
			// would silently block every subsequent feedback submission via the
			// FR-016 in-flight guard).
			const wf = await seedMergePrPause();
			detectNewCommitsResult = ["commit-abc"];

			orchestrator.submitFeedback(wf.id, "do the thing");
			await new Promise((r) => setTimeout(r, 10));

			// The detector would normally flag this candidate; force it to be
			// classified as a question so we can verify the step name guard wins.
			qd._pushDetectResult({
				id: "q-fi",
				content: "Should I proceed?",
				detectedAt: new Date().toISOString(),
			});
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));

			const sentinel = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"done","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
			cli.getLastCallbacks().onOutput(sentinel);
			cli.getLastCallbacks().onOutput("Should I proceed?");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 30));

			expect(wf.status).not.toBe("waiting_for_input");
			expect(wf.pendingQuestion).toBeNull();

			// Success path routed to monitor-ci as expected.
			const monIdx = wf.steps.findIndex((s) => s.name === "monitor-ci");
			expect(wf.currentStepIndex).toBe(monIdx);
		});

		test("feedback success resets ciCycle.attempt and mergeCycle.attempt", async () => {
			// Scenario (review-2 #1.3): the prior CI cycle may have consumed fix-ci
			// attempts; a user-initiated feedback iteration starts a conceptually
			// new cycle and must reset the counters.
			const wf = await seedMergePrPause();
			wf.ciCycle.attempt = 2;
			wf.mergeCycle.attempt = 1;
			detectNewCommitsResult = ["commit-from-feedback"];

			orchestrator.submitFeedback(wf.id, "try again");
			await new Promise((r) => setTimeout(r, 10));

			const sentinel = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"applied","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
			cli.getLastCallbacks().onOutput(sentinel);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 30));

			expect(wf.ciCycle.attempt).toBe(0);
			expect(wf.mergeCycle.attempt).toBe(0);
			const monIdx = wf.steps.findIndex((s) => s.name === "monitor-ci");
			expect(wf.currentStepIndex).toBe(monIdx);
		});

		test("FI prompt excludes the in-flight entry from its feedback context", async () => {
			// Scenario (review-2 #1.4): the FI agent already gets the current
			// iteration via ${latestFeedbackText}; the ${feedbackContext} must not
			// additionally label it as "in progress" — the agent would see the
			// same text twice with different labels.
			const wf = await seedMergePrPause();
			wf.feedbackEntries = [
				{
					id: "fe-prev",
					iteration: 1,
					text: "earlier completed feedback",
					submittedAt: new Date().toISOString(),
					submittedAtStepName: "merge-pr",
					outcome: {
						value: "success",
						summary: "done",
						commitRefs: ["abc"],
						warnings: [],
					},
				},
			];

			orchestrator.submitFeedback(wf.id, "the brand new iteration");
			await new Promise((r) => setTimeout(r, 10));

			const spec = cli._startCalls[cli._startCalls.length - 1].workflow.specification;
			// Prior completed entry IS in the authoritative context block.
			expect(spec).toContain("earlier completed feedback");
			// The in-flight entry's text only appears once (via latestFeedbackText),
			// and no "in progress" label is ever attached to it.
			const inProgressOccurrences = (spec.match(/in progress/g) ?? []).length;
			expect(inProgressOccurrences).toBe(0);
			const latestOccurrences = (spec.match(/the brand new iteration/g) ?? []).length;
			expect(latestOccurrences).toBe(1);
		});

		test("agent-reported failed outcome promotes FI step status to error (review-3 §1.1)", async () => {
			// Locks the data-model contract: when the agent self-reports `failed`
			// with zero new commits, completeFeedbackImplementer must align the FI
			// step's PipelineStep status with the entry outcome (both = error/failed).
			// Otherwise the pipeline-step indicator shows green while the outcome
			// badge shows red.
			const wf = await seedMergePrPause();
			detectNewCommitsResult = [];

			orchestrator.submitFeedback(wf.id, "do the impossible");
			await new Promise((r) => setTimeout(r, 10));

			const sentinel = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"failed","summary":"could not apply: rule conflict","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
			cli.getLastCallbacks().onOutput(sentinel);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 30));

			const entry = wf.feedbackEntries[0];
			expect(entry.outcome?.value).toBe("failed");

			const fiIdx = wf.steps.findIndex((s) => s.name === "feedback-implementer");
			expect(wf.steps[fiIdx].status).toBe("error");
			expect(wf.steps[fiIdx].error).toContain("could not apply");

			// Workflow still rewinds to merge-pr pause (FR-012); only the FI step
			// status reflects the failure.
			const mergeIdx = wf.steps.findIndex((s) => s.name === "merge-pr");
			expect(wf.currentStepIndex).toBe(mergeIdx);
			expect(wf.status).toBe("paused");
		});

		test("agent-reported no-changes leaves FI step status at completed (review-3 §1.1)", async () => {
			// Companion to the §1.1 test above: `no changes` is a successful run
			// that produced nothing — the step ran fine, the agent simply judged
			// no edit was needed. Step status stays `completed`; only the entry
			// outcome differentiates `success` from `no changes`.
			const wf = await seedMergePrPause();
			detectNewCommitsResult = [];

			orchestrator.submitFeedback(wf.id, "no-op please");
			await new Promise((r) => setTimeout(r, 10));

			const sentinel = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"no changes","summary":"already done","materiallyRelevant":false}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
			cli.getLastCallbacks().onOutput(sentinel);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 30));

			const fiIdx = wf.steps.findIndex((s) => s.name === "feedback-implementer");
			expect(wf.steps[fiIdx].status).toBe("completed");
			expect(wf.steps[fiIdx].error).toBeNull();
		});

		test("submitFeedback never broadcasts a {running, currentStep: merge-pr} interim state (review-3 §1.3)", async () => {
			// Locks the broadcast-ordering contract: every onStateChange call must
			// observe a workflow whose current step is feedback-implementer once we
			// reach the running state — never merge-pr-while-running, which is a
			// state the rest of the system asserts cannot happen.
			const wf = await seedMergePrPause();
			const observed: { status: string; stepName: string | undefined }[] = [];
			(callbacks.onStateChange as ReturnType<typeof mock>).mockImplementation(() => {
				observed.push({
					status: wf.status,
					stepName: wf.steps[wf.currentStepIndex]?.name,
				});
			});

			orchestrator.submitFeedback(wf.id, "rename x to count");
			await new Promise((r) => setTimeout(r, 10));

			// No broadcast should ever pair status=running with currentStep=merge-pr
			const offending = observed.filter((o) => o.status === "running" && o.stepName === "merge-pr");
			expect(offending).toEqual([]);

			// And the final observed state lands on feedback-implementer + running
			const last = observed[observed.length - 1];
			expect(last.status).toBe("running");
			expect(last.stepName).toBe("feedback-implementer");
		});

		test("runFeedbackImplementer fires onError when the in-flight entry is missing (review-3 §1.2/§3.2/§3.6)", async () => {
			// Direct programmatic mis-sequencing path: getActiveWorkflow returns a
			// workflow whose feedbackEntries do not contain a null-outcome entry.
			// Drive it by mutating the workflow after the FI step is running so the
			// guard at runFeedbackImplementer's top trips.
			const wf = await seedMergePrPause();

			orchestrator.submitFeedback(wf.id, "test");
			await new Promise((r) => setTimeout(r, 10));

			// Resolve the in-flight entry's outcome from underneath the orchestrator,
			// then trigger another runFeedbackImplementer-style call by re-entering
			// the step. Simulate by directly calling resume after clearing entry.
			wf.feedbackEntries[0].outcome = {
				value: "success",
				summary: "stub",
				commitRefs: [],
				warnings: [],
			};
			// Force the step back to running and re-invoke the entry-guarded path.
			const fiIdx = wf.steps.findIndex((s) => s.name === "feedback-implementer");
			wf.steps[fiIdx].status = "paused";
			wf.steps[fiIdx].sessionId = null;
			wf.status = "paused";

			(callbacks.onError as ReturnType<typeof mock>).mockClear();
			(callbacks.onOutput as ReturnType<typeof mock>).mockClear();

			orchestrator.resume(wf.id);
			await new Promise((r) => setTimeout(r, 30));

			// The early-return guard fires handleStepError → onError (NOT onOutput).
			const errorCalls = (callbacks.onError as ReturnType<typeof mock>).mock.calls;
			expect(errorCalls.length).toBeGreaterThanOrEqual(1);
			expect(errorCalls[0][1]).toContain("No in-flight feedback entry");
		});

		test("runFeedbackImplementer fires onError when prUrl is missing (review-3 §3.2)", async () => {
			const wf = await seedMergePrPause();
			wf.prUrl = null; // simulate the impossible-but-defended case

			(callbacks.onError as ReturnType<typeof mock>).mockClear();

			orchestrator.submitFeedback(wf.id, "anything");
			await new Promise((r) => setTimeout(r, 30));

			const errorCalls = (callbacks.onError as ReturnType<typeof mock>).mock.calls;
			expect(errorCalls.length).toBeGreaterThanOrEqual(1);
			const messages = errorCalls.map((c: unknown[]) => String(c[1]));
			expect(messages.some((m) => m.includes("No PR URL"))).toBe(true);
		});

		test("CLI error in FI emits onError (not onOutput) — review-3 §1.2/§3.6", async () => {
			// Locks the contract: FI failures must go through callbacks.onError,
			// matching every other step's error path. onOutput would lose the
			// logger.error line and the immediate state broadcast.
			const wf = await seedMergePrPause();

			orchestrator.submitFeedback(wf.id, "impossible");
			await new Promise((r) => setTimeout(r, 10));

			(callbacks.onError as ReturnType<typeof mock>).mockClear();
			(callbacks.onOutput as ReturnType<typeof mock>).mockClear();

			cli.getLastCallbacks().onError("agent crashed");
			await new Promise((r) => setTimeout(r, 30));

			const onErrorCalls = (callbacks.onError as ReturnType<typeof mock>).mock.calls;
			expect(onErrorCalls.length).toBeGreaterThanOrEqual(1);
			expect(onErrorCalls[0][1]).toContain("agent crashed");

			// And onOutput is NOT called with the error string disguised as output.
			const errorShapedOutputs = (callbacks.onOutput as ReturnType<typeof mock>).mock.calls.filter(
				(c: unknown[]) => String(c[1]).startsWith("Error: agent crashed"),
			);
			expect(errorShapedOutputs).toEqual([]);
		});

		test("abortPipeline commit-backfill rejection is logged, not unhandled (review-3 §1.5/§3.5)", async () => {
			// Inject a throwing detectNewCommitsFn so the .catch() in abortPipeline
			// fires. The promise must NOT propagate as an unhandled rejection, and
			// commitRefs on the aborted entry stays empty.
			const failingDetect = async (): Promise<string[]> => {
				throw new Error("git unavailable");
			};
			// biome-ignore lint/suspicious/noExplicitAny: test DI
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
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
				getGitHead: async () => "head-sha",
				detectNewCommits: failingDetect,
			};
			orchestrator = new PipelineOrchestrator(callbacks, deps);

			const wf = await seedMergePrPause();
			orchestrator.submitFeedback(wf.id, "do something");
			await new Promise((r) => setTimeout(r, 10));

			orchestrator.pause(wf.id);
			orchestrator.abortPipeline(wf.id);
			// Wait long enough for the swallowed promise's .catch handler to run.
			await new Promise((r) => setTimeout(r, 30));

			const entry = wf.feedbackEntries[0];
			expect(entry.outcome?.value).toBe("aborted");
			expect(entry.outcome?.commitRefs).toEqual([]);
			expect(wf.status).toBe("aborted");
		});

		// retryStep on feedback-implementer is unreachable under today's routing
		// (FI failures rewind to merge-pr pause, never to workflow.status=error).
		// This test locks the guard so a future refactor that routes FI failures
		// to "error" can't silently spawn a CLI with FI's empty static prompt.
		test("retryStep is a no-op on feedback-implementer (FI cannot be retried)", async () => {
			const wf = await seedMergePrPause();
			const fiIdx = wf.steps.findIndex((s) => s.name === "feedback-implementer");
			wf.currentStepIndex = fiIdx;
			wf.steps[fiIdx].status = "error";
			wf.status = "error";

			const callsBefore = cli._startCalls.length;
			await orchestrator.retryStep(wf.id);
			await new Promise((r) => setTimeout(r, 10));

			expect(cli._startCalls.length).toBe(callsBefore);
			expect(wf.status).toBe("error");
		});
	});

	describe("feedback context injection into other CLI steps", () => {
		test("fix-ci prompt is prefixed with the feedback context block when entries exist", async () => {
			configStore.save({ autoMode: "normal" });
			await startAndFlush("test");
			const wf = getWf(engine);
			wf.worktreePath = "/tmp/test-worktree";
			wf.prUrl = "https://github.com/owner/repo/pull/7";
			wf.feedbackEntries = [
				{
					id: "fe-1",
					iteration: 1,
					text: "use XMLHttpRequest instead of fetch",
					submittedAt: new Date().toISOString(),
					submittedAtStepName: "merge-pr",
					outcome: {
						value: "success",
						summary: "replaced fetch",
						commitRefs: ["abc"],
						warnings: [],
					},
				},
			];
			wf.ciCycle.lastCheckResults = [
				{ name: "build", state: "failure", bucket: "fail", link: "http://log" },
			];
			const fixIdx = wf.steps.findIndex((s) => s.name === "fix-ci");
			wf.currentStepIndex = fixIdx;
			wf.steps[fixIdx].status = "running";
			wf.status = "running";

			// Directly invoke retry path which re-enters fix-ci
			// Use resume-style invocation: retryStep works from "error", so simulate via engine transition
			wf.status = "error";
			wf.steps[fixIdx].status = "error";
			await orchestrator.retryStep(wf.id);
			await new Promise((r) => setTimeout(r, 50));

			const lastCall = cli._startCalls[cli._startCalls.length - 1];
			expect(lastCall.workflow.specification).toContain("USER FEEDBACK");
			expect(lastCall.workflow.specification).toContain("use XMLHttpRequest");
		});

		test("no feedback context is injected when feedbackEntries is empty", async () => {
			configStore.save({ autoMode: "normal" });
			await startAndFlush("test");
			const wf = getWf(engine);

			// Advance to specify CLI spawn
			const lastCall = cli._startCalls[cli._startCalls.length - 1];
			expect(lastCall.workflow.specification).not.toContain("USER FEEDBACK");
			expect(wf.feedbackEntries).toEqual([]);

			// Also assert the helper directly, so future callers are pinned to the
			// same empty-string contract regardless of how startStep composes prompts.
			const { buildFeedbackContext } = await import("../src/feedback-injector");
			expect(buildFeedbackContext(wf)).toBe("");
		});
	});

	describe("interrupted feedback-implementer startup recovery (FR-020)", () => {
		test("recoverInterruptedFeedbackImplementer aborts in-flight entry and rewinds to merge-pr pause", async () => {
			const { recoverInterruptedFeedbackImplementer } = await import("../src/feedback-implementer");
			const wf = makeCallbacksWorkflowForRecovery();

			recoverInterruptedFeedbackImplementer(wf);

			const latest = wf.feedbackEntries[wf.feedbackEntries.length - 1];
			expect(latest.outcome?.value).toBe("aborted");
			expect(latest.outcome?.summary).toBe("Interrupted by server restart");
			expect(latest.outcome?.commitRefs).toEqual([]);

			const fiStep = wf.steps.find((s) => s.name === "feedback-implementer");
			expect(fiStep?.status).toBe("pending");
			expect(fiStep?.sessionId).toBeNull();

			const mergeIdx = wf.steps.findIndex((s) => s.name === "merge-pr");
			expect(wf.currentStepIndex).toBe(mergeIdx);
			expect(wf.steps[mergeIdx].status).toBe("paused");
			expect(wf.status).toBe("paused");
		});
	});

	// FR-006: handleStepOutput actually invokes enforceStepOutputCap.
	// If a future refactor deletes or bypasses that call, this asserts the
	// wiring so the bug is caught before shipping.
	describe("step output cap wiring (FR-006)", () => {
		test("handleStepOutput applies the configured cap to step.output", async () => {
			// biome-ignore lint/suspicious/noExplicitAny: override private cap field for test
			(orchestrator as any).maxStepOutputChars = 20;
			await startAndFlush("test");
			const wf = getWf(engine);

			// Drive a chunk of synthetic output > cap through the CLI callback wired
			// to handleStepOutput. Each onOutput appends `${text}\n` → 100+1 chars.
			cli.getLastCallbacks().onOutput("x".repeat(100));

			const step = wf.steps[wf.currentStepIndex];
			expect(step.output.length).toBeLessThanOrEqual(20);
		});
	});

	// Alert emissions (FR-002 … FR-007, FR-013)
	describe("alert emissions", () => {
		function alertCalls(): Array<{
			type: string;
			workflowId: string | null;
			epicId: string | null;
		}> {
			const m = callbacks.onAlertEmit as unknown as { mock: { calls: unknown[][] } };
			return m.mock.calls.map((c) => {
				const input = c[0] as { type: string; workflowId: string | null; epicId: string | null };
				return { type: input.type, workflowId: input.workflowId, epicId: input.epicId };
			});
		}

		test("question-asked emits alert when pipeline pauses (manual mode)", async () => {
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
			expect(alertCalls().some((a) => a.type === "question-asked")).toBe(true);
		});

		test("question-asked NOT emitted in full-auto mode (FR-003)", async () => {
			configStore.save({ autoMode: "full-auto" });
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
			expect(alertCalls().some((a) => a.type === "question-asked")).toBe(false);
		});

		test("answering a question marks the question-asked alert as seen (FR-013)", async () => {
			await startAndFlush("test");
			cli.getLastCallbacks().onSessionId("sess-1");
			const question: Question = {
				id: "q1",
				content: "?",
				detectedAt: new Date().toISOString(),
			};
			qd._pushDetectResult(question);
			qd.classifyWithHaiku.mockImplementationOnce(() => Promise.resolve(true));
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));
			orchestrator.answerQuestion("test-wf-id", "q1", "yes");
			const markSeen = callbacks.onAlertMarkSeenWhere as unknown as {
				mock: { calls: unknown[][] };
			};
			const marked = markSeen.mock.calls.some((c) => {
				const pred = c[0] as (a: { type: string; workflowId?: string }) => boolean;
				return pred({ type: "question-asked", workflowId: "test-wf-id" });
			});
			expect(marked).toBe(true);
		});

		test("pr-opened-manual emits only in manual mode on first PR URL (FR-004)", async () => {
			configStore.save({ autoMode: "manual" });
			const wf = await startAndFlush("test");

			// Advance through specify..implement-review to reach artifacts (index 8)
			// setup(0) auto-completed; specify(1) running.
			for (let i = 0; i < 5; i++) cli.getLastCallbacks().onComplete();
			// review(6) → implement-review(7)
			cli.getLastCallbacks().onComplete();
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			// artifacts(8) completes with empty manifest → commit-push-pr(9)
			seedEmptyArtifactsManifest(wf);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(wf.steps[wf.currentStepIndex].name).toBe("commit-push-pr");

			// Commit step emits PR URL in output
			cli.getLastCallbacks().onOutput("PR opened at https://github.com/owner/repo/pull/42");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));

			expect(alertCalls().some((a) => a.type === "pr-opened-manual")).toBe(true);
		});

		test("pr-opened-manual NOT emitted in normal mode", async () => {
			configStore.save({ autoMode: "normal" });
			const wf = await startAndFlush("test");
			for (let i = 0; i < 5; i++) cli.getLastCallbacks().onComplete();
			cli.getLastCallbacks().onComplete();
			rc._pushClassifyResult("minor");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));
			seedEmptyArtifactsManifest(wf);
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));
			cli.getLastCallbacks().onOutput("PR opened at https://github.com/o/r/pull/42");
			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 20));
			expect(alertCalls().some((a) => a.type === "pr-opened-manual")).toBe(false);
		});

		test("workflow-finished emits on completion when workflow is not part of an epic (FR-005)", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);
			wf.prUrl = "https://github.com/o/r/pull/1";
			// Directly drive completion via the internal helper by simulating terminal route.
			// Simpler: invoke completeWorkflow path by setting status.
			// biome-ignore lint/suspicious/noExplicitAny: private access for focused test
			(orchestrator as any).completeWorkflow(wf);
			expect(
				alertCalls().some((a) => a.type === "workflow-finished" && a.workflowId === wf.id),
			).toBe(true);
		});

		test("workflow-finished NOT emitted for child of an epic (FR-006 guard)", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);
			wf.epicId = "epic-1";
			wf.epicTitle = "My Epic";
			// biome-ignore lint/suspicious/noExplicitAny: private access for focused test
			(orchestrator as any).completeWorkflow(wf);
			await new Promise((r) => setTimeout(r, 20));
			expect(alertCalls().some((a) => a.type === "workflow-finished")).toBe(false);
		});

		test("error alert emitted on handleStepError (FR-007)", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);
			// biome-ignore lint/suspicious/noExplicitAny: private access for focused test
			(orchestrator as any).handleStepError(wf.id, "something blew up");
			expect(alertCalls().some((a) => a.type === "error" && a.workflowId === wf.id)).toBe(true);
		});

		test("epic-finished emits when all siblings terminal, independent of onEpicDependencyUpdate", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);
			wf.epicId = "epic-1";
			wf.epicTitle = "Finish me";

			const siblingTerminal: Workflow = {
				...wf,
				id: "sibling",
				status: "completed" as WorkflowStatus,
				epicDependencies: [],
			};
			store.loadAll.mockImplementationOnce(async () => [wf, siblingTerminal]);

			// Drop onEpicDependencyUpdate to prove the emit is independent.
			const depCb = callbacks.onEpicDependencyUpdate;
			callbacks.onEpicDependencyUpdate = undefined;

			// biome-ignore lint/suspicious/noExplicitAny: private access for focused test
			await (orchestrator as any).checkEpicDependencies(wf);

			callbacks.onEpicDependencyUpdate = depCb;
			expect(alertCalls().some((a) => a.type === "epic-finished" && a.epicId === "epic-1")).toBe(
				true,
			);
		});

		test("checkEpicDependencies waits for pending writes before loading siblings (race fix)", async () => {
			// If a sibling's save is in flight when we loadAll, it can appear as
			// "running" on disk and we'd miss the epic-finished emit. The fix
			// awaits `waitForPendingWrites` before `loadAll`; this test asserts
			// that ordering by checking `waitForPendingWrites` is called first.
			await startAndFlush("test");
			const wf = getWf(engine);
			wf.epicId = "epic-1";

			const callOrder: string[] = [];
			store.waitForPendingWrites.mockImplementationOnce(async () => {
				callOrder.push("waitForPendingWrites");
			});
			store.loadAll.mockImplementationOnce(async () => {
				callOrder.push("loadAll");
				return [wf];
			});

			// biome-ignore lint/suspicious/noExplicitAny: private access for focused test
			await (orchestrator as any).checkEpicDependencies(wf);

			expect(callOrder).toEqual(["waitForPendingWrites", "loadAll"]);
		});

		test("handleStepError marks pending question-asked alert as seen", async () => {
			await startAndFlush("test");
			const wf = getWf(engine);
			// Simulate a pending question; handleStepError should mark any
			// pending question alert seen so its badge contribution is cleared.
			wf.pendingQuestion = {
				id: "q1",
				content: "?",
				detectedAt: new Date().toISOString(),
			};
			// biome-ignore lint/suspicious/noExplicitAny: private access for focused test
			(orchestrator as any).handleStepError(wf.id, "boom");
			const markSeen = callbacks.onAlertMarkSeenWhere as unknown as {
				mock: { calls: unknown[][] };
			};
			const markedQuestion = markSeen.mock.calls.some((c) => {
				const pred = c[0] as (a: { type: string; workflowId?: string }) => boolean;
				return pred({ type: "question-asked", workflowId: wf.id });
			});
			expect(markedQuestion).toBe(true);
		});
	});
});

function makeCallbacksWorkflowForRecovery(): Workflow {
	const now = new Date().toISOString();
	const wf: Workflow = {
		id: "recovery-test",
		workflowKind: "spec",
		specification: "test",
		status: "running" as WorkflowStatus,
		targetRepository: "/tmp/repo",
		worktreePath: "/tmp/wt",
		worktreeBranch: "test",
		featureBranch: null,
		summary: "",
		stepSummary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: getStepDefinitionsForKind("spec").map((def) => ({
			name: def.name,
			displayName: def.displayName,
			status: "pending" as const,
			prompt: def.prompt,
			sessionId: null,
			output: "",
			outputLog: [],
			error: null,
			startedAt: null,
			completedAt: null,
			pid: null,
			history: [],
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
		mergeCycle: { attempt: 0, maxAttempts: 3 },
		prUrl: null,
		epicId: null,
		epicTitle: null,
		epicDependencies: [],
		epicDependencyStatus: null,
		epicAnalysisMs: 0,
		activeWorkMs: 0,
		activeWorkStartedAt: now,
		feedbackEntries: [
			{
				id: "fe-1",
				iteration: 1,
				text: "refactor everything",
				submittedAt: now,
				submittedAtStepName: "merge-pr",
				outcome: null,
			},
		],
		feedbackPreRunHead: "head-before-restart-sha",
		activeInvocation: null,
		managedRepo: null,
		error: null,
		hasEverStarted: false,
		createdAt: now,
		updatedAt: now,
		archived: false,
		archivedAt: null,
	};
	const fiIdx = wf.steps.findIndex((s) => s.name === "feedback-implementer");
	wf.currentStepIndex = fiIdx;
	wf.steps[fiIdx].status = "running";
	wf.steps[fiIdx].sessionId = "old-session";
	wf.steps[fiIdx].output = "partial output";
	return wf;
}
