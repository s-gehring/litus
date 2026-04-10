import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { MonitorResult } from "../src/ci-monitor";
import type { CLICallbacks } from "../src/cli-runner";
import { configStore, DEFAULT_CONFIG } from "../src/config-store";
import { type PipelineCallbacks, PipelineOrchestrator } from "../src/pipeline-orchestrator";
import type { Question, ReviewSeverity, Workflow, WorkflowStatus } from "../src/types";
import { PIPELINE_STEP_DEFINITIONS } from "../src/types";

// ── Module mocks ──────────────────────────────────────────────────────

let monitorResultResolve: (result: MonitorResult) => void;
let _monitorResultReject: (err: Error) => void;

const mockStartMonitoring = mock(
	(
		_prUrl: string,
		_ciCycle: unknown,
		_onOutput: (msg: string) => void,
		_signal?: AbortSignal,
	): Promise<MonitorResult> => {
		return new Promise((resolve, reject) => {
			monitorResultResolve = resolve;
			_monitorResultReject = reject;
		});
	},
);

const mockGatherAllFailureLogs = mock(async () => []);

mock.module("../src/ci-monitor", () => ({
	startMonitoring: mockStartMonitoring,
	isValidPrUrl: (url: string) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url),
	checkGhAuth: async () => {},
}));

mock.module("../src/ci-fixer", () => {
	const real = require("../src/ci-fixer");
	return {
		...real,
		gatherAllFailureLogs: mockGatherAllFailureLogs,
	};
});

// ── Fake dependencies (same pattern as pipeline-orchestrator.test.ts) ─

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
		_getWorkflow: () => workflow,
	};
}

function createFakeCliRunner() {
	const startCalls: Array<{ workflow: Workflow; callbacks: CLICallbacks }> = [];

	return {
		start: (workflow: Workflow, callbacks: CLICallbacks) => {
			startCalls.push({ workflow, callbacks });
			callbacks.onOutput("[test] CLI step running");
		},
		kill: mock((_id: string) => {}),
		resume: mock((_workflow: Workflow, _callbacks: CLICallbacks) => {}),
		killAll: mock(() => {}),
		_startCalls: startCalls,
		getLastCallbacks: (): CLICallbacks => startCalls[startCalls.length - 1].callbacks,
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
	};
}

function getWf(eng: ReturnType<typeof createFakeEngine>): Workflow {
	const wf = eng._getWorkflow();
	if (!wf) throw new Error("Expected workflow to exist");
	return wf;
}

// ── Helpers ───────────────────────────────────────────────────────────

function createFakeReviewClassifier() {
	const classifyResults: ReviewSeverity[] = [];
	return {
		classify: async (_output: string): Promise<ReviewSeverity> =>
			classifyResults.shift() ?? "minor",
		_pushClassifyResult: (r: ReviewSeverity) => classifyResults.push(r),
	};
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("CI Pipeline Routing", () => {
	let orchestrator: PipelineOrchestrator;
	let callbacks: PipelineCallbacks;
	let engine: ReturnType<typeof createFakeEngine>;
	let cli: ReturnType<typeof createFakeCliRunner>;
	let classifier: ReturnType<typeof createFakeReviewClassifier>;

	beforeEach(async () => {
		mockStartMonitoring.mockClear();
		mockGatherAllFailureLogs.mockClear();

		callbacks = makeCallbacks();
		engine = createFakeEngine();
		cli = createFakeCliRunner();
		classifier = createFakeReviewClassifier();

		orchestrator = new PipelineOrchestrator(callbacks, {
			engine: engine as never,
			cliRunner: cli as never,
			questionDetector: {
				detect: () => null,
				classifyWithHaiku: async () => false,
				reset: () => {},
			} as never,
			reviewClassifier: classifier as never,
			summarizer: {
				maybeSummarize: () => {},
				generateSpecSummary: async () => ({ summary: "", flavor: "" }),
				resetBuffer: () => {},
				cleanup: () => {},
			} as never,
			auditLogger: {
				startRun: () => "fake-audit-id",
				endRun: () => {},
				logQuery: () => {},
				logAnswer: () => {},
				logCommit: () => {},
			} as never,
			workflowStore: {
				save: async () => {},
				load: async () => null,
				loadAll: async () => [],
				loadIndex: async () => [],
				remove: async () => {},
			} as never,
			runSetupChecks: async () => ({
				passed: true,
				checks: [],
				requiredFailures: [],
				optionalWarnings: [],
			}),
			ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
			checkoutMaster: async () => ({ code: 0, stderr: "" }),
		});

		// Ensure predictable auto mode (disk config may differ)
		configStore.save({ autoMode: "normal" });

		await orchestrator.startPipeline("test spec", "/tmp/test-repo");
		// start() triggers the first step (specify) — we need to provide CLI callbacks
		await new Promise((r) => setTimeout(r, 10));
	});

	test("monitor-ci success → routes to merge-pr", async () => {
		const wf = getWf(engine);
		wf.prUrl = "https://github.com/owner/repo/pull/42";

		// Fast-forward to monitor-ci
		const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
		const commitIndex = monitorIndex - 1;
		wf.currentStepIndex = commitIndex;
		wf.steps[commitIndex].status = "running";
		wf.steps[commitIndex].startedAt = new Date().toISOString();
		wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

		// Complete commit-push-pr → routes to monitor-ci
		cli.getLastCallbacks().onComplete();
		await new Promise((r) => setTimeout(r, 10));

		expect(wf.steps[monitorIndex].status).toBe("running");
		expect(mockStartMonitoring).toHaveBeenCalledTimes(1);

		// Resolve monitoring with success
		monitorResultResolve({ passed: true, timedOut: false, results: [] });
		await new Promise((r) => setTimeout(r, 10));

		// After monitor-ci passes, routes to merge-pr
		const mergePrIndex = wf.steps.findIndex((s) => s.name === "merge-pr");
		expect(wf.currentStepIndex).toBe(mergePrIndex);
		// merge-pr step was entered (status is running or error depending on gh availability)
		expect(["running", "error"]).toContain(wf.steps[mergePrIndex].status);
	});

	test("monitor-ci failure → routes to fix-ci", async () => {
		const wf = getWf(engine);
		wf.prUrl = "https://github.com/owner/repo/pull/42";

		const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
		const fixIndex = wf.steps.findIndex((s) => s.name === "fix-ci");
		const commitIndex = monitorIndex - 1;
		wf.currentStepIndex = commitIndex;
		wf.steps[commitIndex].status = "running";
		wf.steps[commitIndex].startedAt = new Date().toISOString();
		wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

		cli.getLastCallbacks().onComplete();
		await new Promise((r) => setTimeout(r, 10));

		// Resolve monitoring with failure
		const failedResults = [{ name: "build", state: "COMPLETED", bucket: "fail", link: "" }];
		monitorResultResolve({ passed: false, timedOut: false, results: failedResults });
		await new Promise((r) => setTimeout(r, 10));

		expect(wf.currentStepIndex).toBe(fixIndex);
		expect(wf.steps[fixIndex].status).toBe("running");
		expect(wf.ciCycle.lastCheckResults).toEqual(failedResults);
	});

	test("fix-ci completion → routes back to monitor-ci with incremented attempt", async () => {
		const wf = getWf(engine);
		wf.prUrl = "https://github.com/owner/repo/pull/42";

		const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
		const fixIndex = wf.steps.findIndex((s) => s.name === "fix-ci");
		const commitIndex = monitorIndex - 1;
		wf.currentStepIndex = commitIndex;
		wf.steps[commitIndex].status = "running";
		wf.steps[commitIndex].startedAt = new Date().toISOString();
		wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

		cli.getLastCallbacks().onComplete();
		await new Promise((r) => setTimeout(r, 10));

		// Monitor fails
		monitorResultResolve({
			passed: false,
			timedOut: false,
			results: [{ name: "build", state: "COMPLETED", bucket: "fail", link: "" }],
		});
		await new Promise((r) => setTimeout(r, 10));

		expect(wf.currentStepIndex).toBe(fixIndex);

		// fix-ci completes → should route back to monitor-ci
		cli.getLastCallbacks().onComplete();
		await new Promise((r) => setTimeout(r, 10));

		expect(wf.ciCycle.attempt).toBe(1);
		expect(wf.currentStepIndex).toBe(monitorIndex);
		expect(wf.steps[monitorIndex].status).toBe("running");
	});

	test("max attempts reached → workflow errors", async () => {
		const wf = getWf(engine);
		wf.prUrl = "https://github.com/owner/repo/pull/42";
		wf.ciCycle.attempt = 3;
		wf.ciCycle.maxAttempts = 3;

		const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
		const commitIndex = monitorIndex - 1;
		wf.currentStepIndex = commitIndex;
		wf.steps[commitIndex].status = "running";
		wf.steps[commitIndex].startedAt = new Date().toISOString();
		wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

		cli.getLastCallbacks().onComplete();
		await new Promise((r) => setTimeout(r, 10));

		// Monitor fails — but max attempts already reached
		monitorResultResolve({
			passed: false,
			timedOut: false,
			results: [{ name: "build", state: "COMPLETED", bucket: "fail", link: "" }],
		});
		await new Promise((r) => setTimeout(r, 10));

		expect(wf.status).toBe("error");
		expect(wf.steps[monitorIndex].error).toContain("3 fix attempts");
	});

	test("timeout → treated as failure and routes appropriately", async () => {
		const wf = getWf(engine);
		wf.prUrl = "https://github.com/owner/repo/pull/42";

		const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
		const fixIndex = wf.steps.findIndex((s) => s.name === "fix-ci");
		const commitIndex = monitorIndex - 1;
		wf.currentStepIndex = commitIndex;
		wf.steps[commitIndex].status = "running";
		wf.steps[commitIndex].startedAt = new Date().toISOString();
		wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

		cli.getLastCallbacks().onComplete();
		await new Promise((r) => setTimeout(r, 10));

		// Monitor times out
		monitorResultResolve({
			passed: false,
			timedOut: true,
			results: [{ name: "build", state: "IN_PROGRESS", bucket: "pending", link: "" }],
		});
		await new Promise((r) => setTimeout(r, 10));

		// Should route to fix-ci (attempt 0 < maxAttempts 3)
		expect(wf.currentStepIndex).toBe(fixIndex);
	});

	test("all checks cancelled → pauses for human intervention", async () => {
		const wf = getWf(engine);
		wf.prUrl = "https://github.com/owner/repo/pull/42";

		const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
		const commitIndex = monitorIndex - 1;
		wf.currentStepIndex = commitIndex;
		wf.steps[commitIndex].status = "running";
		wf.steps[commitIndex].startedAt = new Date().toISOString();
		wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

		cli.getLastCallbacks().onComplete();
		await new Promise((r) => setTimeout(r, 10));

		// All checks cancelled (usage limit scenario)
		monitorResultResolve({
			passed: false,
			timedOut: false,
			results: [
				{ name: "build", state: "COMPLETED", bucket: "cancel", link: "" },
				{ name: "test", state: "COMPLETED", bucket: "cancel", link: "" },
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		expect(wf.status).toBe("waiting_for_input");
		expect(wf.pendingQuestion).not.toBeNull();
		expect(wf.pendingQuestion?.content).toContain("cancelled");
		expect(wf.pendingQuestion?.content).toContain("usage limits");
	});

	test("cancelled checks + user answers retry → resumes monitoring", async () => {
		const wf = getWf(engine);
		wf.prUrl = "https://github.com/owner/repo/pull/42";

		const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
		const commitIndex = monitorIndex - 1;
		wf.currentStepIndex = commitIndex;
		wf.steps[commitIndex].status = "running";
		wf.steps[commitIndex].startedAt = new Date().toISOString();
		wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

		cli.getLastCallbacks().onComplete();
		await new Promise((r) => setTimeout(r, 10));

		monitorResultResolve({
			passed: false,
			timedOut: false,
			results: [{ name: "build", state: "COMPLETED", bucket: "cancel", link: "" }],
		});
		await new Promise((r) => setTimeout(r, 10));

		expect(wf.status).toBe("waiting_for_input");
		const questionId = wf.pendingQuestion?.id;

		// User answers "retry"
		mockStartMonitoring.mockClear();
		orchestrator.answerQuestion(wf.id, questionId as string, "retry");
		await new Promise((r) => setTimeout(r, 10));

		expect(wf.status).toBe("running");
		expect(wf.pendingQuestion).toBeNull();
		expect(mockStartMonitoring).toHaveBeenCalledTimes(1);
	});

	test("cancelled checks + user answers abort → workflow errors", async () => {
		const wf = getWf(engine);
		wf.prUrl = "https://github.com/owner/repo/pull/42";

		const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
		const commitIndex = monitorIndex - 1;
		wf.currentStepIndex = commitIndex;
		wf.steps[commitIndex].status = "running";
		wf.steps[commitIndex].startedAt = new Date().toISOString();
		wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

		cli.getLastCallbacks().onComplete();
		await new Promise((r) => setTimeout(r, 10));

		monitorResultResolve({
			passed: false,
			timedOut: false,
			results: [{ name: "build", state: "COMPLETED", bucket: "cancel", link: "" }],
		});
		await new Promise((r) => setTimeout(r, 10));

		const questionId = wf.pendingQuestion?.id;
		orchestrator.answerQuestion(wf.id, questionId as string, "abort");
		await new Promise((r) => setTimeout(r, 10));

		expect(wf.status).toBe("error");
	});

	test("mixed FAILURE and CANCELLED → routes to fix-ci (not paused)", async () => {
		const wf = getWf(engine);
		wf.prUrl = "https://github.com/owner/repo/pull/42";

		const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
		const fixIndex = wf.steps.findIndex((s) => s.name === "fix-ci");
		const commitIndex = monitorIndex - 1;
		wf.currentStepIndex = commitIndex;
		wf.steps[commitIndex].status = "running";
		wf.steps[commitIndex].startedAt = new Date().toISOString();
		wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

		cli.getLastCallbacks().onComplete();
		await new Promise((r) => setTimeout(r, 10));

		// Mix of FAILURE and CANCELLED — real code issue with cascading cancellations
		monitorResultResolve({
			passed: false,
			timedOut: false,
			results: [
				{ name: "build", state: "COMPLETED", bucket: "fail", link: "" },
				{ name: "test", state: "COMPLETED", bucket: "cancel", link: "" },
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		// Should route to fix-ci, not pause
		expect(wf.currentStepIndex).toBe(fixIndex);
		expect(wf.status).toBe("running");
	});

	test("timeout at max attempts → workflow errors with timeout message", async () => {
		const wf = getWf(engine);
		wf.prUrl = "https://github.com/owner/repo/pull/42";
		wf.ciCycle.attempt = 3;
		wf.ciCycle.maxAttempts = 3;

		const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
		const commitIndex = monitorIndex - 1;
		wf.currentStepIndex = commitIndex;
		wf.steps[commitIndex].status = "running";
		wf.steps[commitIndex].startedAt = new Date().toISOString();
		wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

		cli.getLastCallbacks().onComplete();
		await new Promise((r) => setTimeout(r, 10));

		monitorResultResolve({
			passed: false,
			timedOut: true,
			results: [],
		});
		await new Promise((r) => setTimeout(r, 10));

		expect(wf.status).toBe("error");
		expect(wf.steps[monitorIndex].error).toContain("timed out");
	});

	// T008: Pause-before-merge in manual mode
	describe("pause-before-merge (manual mode)", () => {
		test("pauses workflow when entering merge-pr step in manual mode", async () => {
			configStore.save({ autoMode: "manual" });
			const wf = getWf(engine);
			wf.prUrl = "https://github.com/owner/repo/pull/42";

			// Fast-forward to monitor-ci
			const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
			const commitIndex = monitorIndex - 1;
			wf.currentStepIndex = commitIndex;
			wf.steps[commitIndex].status = "running";
			wf.steps[commitIndex].startedAt = new Date().toISOString();
			wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 10));

			// Resolve monitoring with success
			monitorResultResolve({ passed: true, timedOut: false, results: [] });
			await new Promise((r) => setTimeout(r, 10));

			// Should pause at merge-pr in manual mode
			const mergePrIndex = wf.steps.findIndex((s) => s.name === "merge-pr");
			expect(wf.currentStepIndex).toBe(mergePrIndex);
			expect(wf.status as string).toBe("paused");
			expect(wf.steps[mergePrIndex].status as string).toBe("paused");

			// Should emit contextual message with PR link (FR-012)
			const outputCalls = (callbacks.onOutput as ReturnType<typeof mock>).mock.calls;
			const pauseMsg = outputCalls.find(
				(c: unknown[]) => typeof c[1] === "string" && c[1].includes("[manual mode]"),
			);
			expect(pauseMsg).toBeDefined();
			expect(pauseMsg?.[1]).toContain("https://github.com/owner/repo/pull/42");
		});

		test("does NOT pause before merge in normal mode", async () => {
			configStore.save({ autoMode: "normal" });
			const wf = getWf(engine);
			wf.prUrl = "https://github.com/owner/repo/pull/42";

			const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
			const commitIndex = monitorIndex - 1;
			wf.currentStepIndex = commitIndex;
			wf.steps[commitIndex].status = "running";
			wf.steps[commitIndex].startedAt = new Date().toISOString();
			wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 10));

			monitorResultResolve({ passed: true, timedOut: false, results: [] });
			await new Promise((r) => setTimeout(r, 10));

			const mergePrIndex = wf.steps.findIndex((s) => s.name === "merge-pr");
			expect(wf.currentStepIndex).toBe(mergePrIndex);
			expect(wf.steps[mergePrIndex].status).not.toBe("paused");
		});

		test("resume after manual-mode pause dispatches to runMergePr", async () => {
			const mockMergePr = mock(
				async (_prUrl: string, _cwd: string, _onOutput: (msg: string) => void) => ({
					merged: true,
					alreadyMerged: false,
					conflict: false,
					error: null,
				}),
			);

			// Create a separate orchestrator with mock mergePr
			const localEngine = createFakeEngine();
			const localCli = createFakeCliRunner();
			const localCallbacks = makeCallbacks();
			const localOrchestrator = new PipelineOrchestrator(localCallbacks, {
				engine: localEngine as never,
				cliRunner: localCli as never,
				questionDetector: {
					detect: () => null,
					classifyWithHaiku: async () => false,
					reset: () => {},
				} as never,
				reviewClassifier: classifier as never,
				summarizer: {
					maybeSummarize: () => {},
					generateSpecSummary: async () => ({ summary: "", flavor: "" }),
					resetBuffer: () => {},
					cleanup: () => {},
				} as never,
				auditLogger: {
					startRun: () => "fake-audit-id",
					endRun: () => {},
					logQuery: () => {},
					logAnswer: () => {},
					logCommit: () => {},
				} as never,
				workflowStore: {
					save: async () => {},
					load: async () => null,
					loadAll: async () => [],
					loadIndex: async () => [],
					remove: async () => {},
				} as never,
				mergePr: mockMergePr as never,
				runSetupChecks: async () => ({
					passed: true,
					checks: [],
					requiredFailures: [],
					optionalWarnings: [],
				}),
				ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
				checkoutMaster: async () => ({ code: 0, stderr: "" }),
			});

			configStore.save({ autoMode: "manual" });
			await localOrchestrator.startPipeline("test spec", "/tmp/test-repo");
			await new Promise((r) => setTimeout(r, 10));

			const wf = getWf(localEngine);
			wf.prUrl = "https://github.com/owner/repo/pull/42";

			// Fast-forward to pre-monitor step and complete it
			const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
			const commitIndex = monitorIndex - 1;
			wf.currentStepIndex = commitIndex;
			wf.steps[commitIndex].status = "running";
			wf.steps[commitIndex].startedAt = new Date().toISOString();
			wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

			localCli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 10));

			monitorResultResolve({ passed: true, timedOut: false, results: [] });
			await new Promise((r) => setTimeout(r, 10));

			// Verify paused at merge-pr
			const mergePrIndex = wf.steps.findIndex((s) => s.name === "merge-pr");
			expect(wf.status as string).toBe("paused");
			expect(wf.steps[mergePrIndex].status as string).toBe("paused");

			// Resume — should call runMergePr which invokes mockMergePr
			localOrchestrator.resume(wf.id);
			await new Promise((r) => setTimeout(r, 10));

			expect(mockMergePr).toHaveBeenCalledTimes(1);
			expect(mockMergePr.mock.calls[0][0]).toBe("https://github.com/owner/repo/pull/42");
		});

		test("does NOT pause before merge in full-auto mode", async () => {
			configStore.save({ autoMode: "full-auto" });
			const wf = getWf(engine);
			wf.prUrl = "https://github.com/owner/repo/pull/42";

			const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
			const commitIndex = monitorIndex - 1;
			wf.currentStepIndex = commitIndex;
			wf.steps[commitIndex].status = "running";
			wf.steps[commitIndex].startedAt = new Date().toISOString();
			wf.steps[commitIndex].output = "Created PR https://github.com/owner/repo/pull/42";

			cli.getLastCallbacks().onComplete();
			await new Promise((r) => setTimeout(r, 10));

			monitorResultResolve({ passed: true, timedOut: false, results: [] });
			await new Promise((r) => setTimeout(r, 10));

			const mergePrIndex = wf.steps.findIndex((s) => s.name === "merge-pr");
			expect(wf.currentStepIndex).toBe(mergePrIndex);
			expect(wf.steps[mergePrIndex].status).not.toBe("paused");
		});
	});
});
