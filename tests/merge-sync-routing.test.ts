import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { MonitorResult } from "../src/ci-monitor";
import type { CLICallbacks } from "../src/cli-runner";
import { configStore, DEFAULT_CONFIG } from "../src/config-store";
import { type PipelineCallbacks, PipelineOrchestrator } from "../src/pipeline-orchestrator";
import type { ConflictResolutionResult } from "../src/pr-merger";
import type {
	MergeResult,
	Question,
	ReviewSeverity,
	SyncResult,
	Workflow,
	WorkflowStatus,
} from "../src/types";
import { PIPELINE_STEP_DEFINITIONS } from "../src/types";

// ── Module mocks ──────────────────────────────────────────────────────

let monitorResultResolve: (result: MonitorResult) => void;

const mockStartMonitoring = mock(
	(
		_prUrl: string,
		_ciCycle: unknown,
		_onOutput: (msg: string) => void,
		_signal?: AbortSignal,
	): Promise<MonitorResult> => {
		return new Promise((resolve) => {
			monitorResultResolve = resolve;
		});
	},
);

let mergePrResult: MergeResult = {
	merged: true,
	alreadyMerged: false,
	conflict: false,
	error: null,
};
const mockMergePr = mock(
	async (_prUrl: string, _cwd: string, _onOutput: (msg: string) => void): Promise<MergeResult> => {
		return mergePrResult;
	},
);

let resolveConflictsResult: ConflictResolutionResult = { kind: "resolved" };
const mockResolveConflicts = mock(
	async (
		_cwd: string,
		_specSummary: string,
		_onOutput: (msg: string) => void,
	): Promise<ConflictResolutionResult> => {
		return resolveConflictsResult;
	},
);

let syncRepoResult: SyncResult = {
	pulled: true,
	skipped: false,
	worktreeRemoved: true,
	warning: null,
};
const mockSyncRepo = mock(
	async (
		_targetRepo: string,
		_worktreePath: string | null,
		_engine: unknown,
		_workflowId: string,
		_onOutput: (msg: string) => void,
	): Promise<SyncResult> => {
		return syncRepoResult;
	},
);

mock.module("../src/ci-monitor", () => {
	const real = require("../src/ci-monitor");
	return {
		...real,
		startMonitoring: mockStartMonitoring,
		checkGhAuth: async () => {},
	};
});

mock.module("../src/ci-fixer", () => {
	const real = require("../src/ci-fixer");
	return { ...real, gatherAllFailureLogs: mock(async () => []) };
});

// pr-merger and repo-syncer are injected via PipelineDeps (no mock.module needed)

// ── Fake dependencies ─────────────────────────────────────────────────

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
		removeWorktree: mock(async () => {}),
		moveWorktree: mock(async () => "/tmp/test-worktree"),
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

function createFakeReviewClassifier() {
	const classifyResults: ReviewSeverity[] = [];
	return {
		classify: async (_output: string): Promise<ReviewSeverity> =>
			classifyResults.shift() ?? "minor",
		_pushClassifyResult: (r: ReviewSeverity) => classifyResults.push(r),
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

// ── Tests ─────────────────────────────────────────────────────────────

describe("Merge & Sync Pipeline Routing", () => {
	let orchestrator: PipelineOrchestrator;
	let callbacks: PipelineCallbacks;
	let engine: ReturnType<typeof createFakeEngine>;
	let cli: ReturnType<typeof createFakeCliRunner>;
	let rc: ReturnType<typeof createFakeReviewClassifier>;

	beforeEach(() => {
		configStore.save({ autoMode: "normal" });
		callbacks = makeCallbacks();
		engine = createFakeEngine();
		cli = createFakeCliRunner();
		rc = createFakeReviewClassifier();

		mergePrResult = { merged: true, alreadyMerged: false, conflict: false, error: null };
		resolveConflictsResult = { kind: "resolved" };
		syncRepoResult = { pulled: true, skipped: false, worktreeRemoved: true, warning: null };
		mockMergePr.mockClear();
		mockResolveConflicts.mockClear();
		mockSyncRepo.mockClear();
		mockStartMonitoring.mockClear();

		// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fakes
		const deps: Record<string, any> = {
			engine,
			cliRunner: cli,
			questionDetector: {
				detect: () => null,
				classifyWithHaiku: mock(async () => false),
				reset: mock(() => {}),
			},
			reviewClassifier: rc,
			summarizer: {
				maybeSummarize: mock(() => {}),
				generateSpecSummary: mock(async () => ({ summary: "", flavor: "" })),
				resetBuffer: mock(() => {}),
				cleanup: mock(() => {}),
			},
			auditLogger: {
				startRun: mock(() => "fake-audit-run-id"),
				endRun: mock(() => {}),
				logQuery: mock(() => {}),
				logAnswer: mock(() => {}),
				logCommit: mock(() => {}),
			},
			workflowStore: {
				save: mock(async () => {}),
				load: mock(async () => null),
				loadAll: mock(async () => []),
				loadIndex: mock(async () => []),
				remove: mock(async () => {}),
			},
			mergePr: mockMergePr,
			resolveConflicts: mockResolveConflicts,
			syncRepo: mockSyncRepo,
			runSetupChecks: async () => ({
				passed: true,
				checks: [],
				requiredFailures: [],
				optionalWarnings: [],
			}),
			ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
			checkoutMaster: async () => ({ code: 0, stderr: "" }),
		};
		orchestrator = new PipelineOrchestrator(callbacks, deps);
	});

	async function advanceToMonitorCi() {
		await orchestrator.startPipeline("test", "/tmp/test-repo");
		await new Promise((r) => setTimeout(r, 0));
		const wf = getWf(engine);
		wf.prUrl = "https://github.com/owner/repo/pull/42";

		// Complete steps 1-5 (specify → implement)
		for (let i = 0; i < 5; i++) {
			cli.getLastCallbacks().onComplete();
		}

		// Review → implement-review → minor → commit-push-pr
		cli.getLastCallbacks().onComplete(); // review → implement-review
		rc._pushClassifyResult("minor");
		cli.getLastCallbacks().onComplete(); // implement-review → classify
		await new Promise((r) => setTimeout(r, 20));

		// commit-push-pr → monitor-ci
		cli.getLastCallbacks().onComplete();
		return wf;
	}

	// T014: monitor-ci → merge-pr → sync-repo happy path
	test("monitor-ci → merge-pr → sync-repo → completed", async () => {
		const wf = await advanceToMonitorCi();

		const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
		expect(wf.currentStepIndex).toBe(monitorIndex);

		// Resolve monitoring with success
		monitorResultResolve({ passed: true, timedOut: false, results: [] });
		await new Promise((r) => setTimeout(r, 20));

		// Should route to merge-pr
		const mergePrIndex = wf.steps.findIndex((s) => s.name === "merge-pr");
		expect(wf.steps[mergePrIndex].status).not.toBe("pending");
		expect(mockMergePr).toHaveBeenCalledTimes(1);

		await new Promise((r) => setTimeout(r, 20));

		// After successful merge, routes to sync-repo
		const syncRepoIndex = wf.steps.findIndex((s) => s.name === "sync-repo");
		expect(wf.steps[syncRepoIndex].status).not.toBe("pending");
		expect(mockSyncRepo).toHaveBeenCalledTimes(1);

		await new Promise((r) => setTimeout(r, 20));

		// After sync-repo, workflow completes
		expect(wf.status).toBe("completed");
	});

	test("already-merged PR routes to sync-repo", async () => {
		mergePrResult = { merged: false, alreadyMerged: true, conflict: false, error: null };

		const wf = await advanceToMonitorCi();
		monitorResultResolve({ passed: true, timedOut: false, results: [] });
		await new Promise((r) => setTimeout(r, 40));

		expect(mockMergePr).toHaveBeenCalledTimes(1);
		expect(mockSyncRepo).toHaveBeenCalledTimes(1);
		expect(wf.status).toBe("completed");
	});

	test("merge-pr non-conflict error transitions to error state", async () => {
		mergePrResult = {
			merged: false,
			alreadyMerged: false,
			conflict: false,
			error: "Permission denied",
		};

		const wf = await advanceToMonitorCi();
		monitorResultResolve({ passed: true, timedOut: false, results: [] });
		await new Promise((r) => setTimeout(r, 40));

		expect(wf.status).toBe("error");
		const mergePrIndex = wf.steps.findIndex((s) => s.name === "merge-pr");
		expect(wf.steps[mergePrIndex].error).toBe("Permission denied");
	});

	test("merge conflict triggers resolution and loops back to monitor-ci", async () => {
		// First attempt: conflict. Second attempt: success.
		mergePrResult = { merged: false, alreadyMerged: false, conflict: true, error: null };

		const wf = await advanceToMonitorCi();
		monitorResultResolve({ passed: true, timedOut: false, results: [] });
		await new Promise((r) => setTimeout(r, 40));

		expect(mockResolveConflicts).toHaveBeenCalledTimes(1);
		expect(wf.mergeCycle.attempt).toBe(2);

		// Should loop back to monitor-ci
		const monitorIndex = wf.steps.findIndex((s) => s.name === "monitor-ci");
		expect(wf.currentStepIndex).toBe(monitorIndex);

		// Second round: merge succeeds
		mergePrResult = { merged: true, alreadyMerged: false, conflict: false, error: null };
		monitorResultResolve({ passed: true, timedOut: false, results: [] });
		await new Promise((r) => setTimeout(r, 40));

		expect(mockMergePr).toHaveBeenCalledTimes(2);
		expect(mockSyncRepo).toHaveBeenCalledTimes(1);
		expect(wf.status).toBe("completed");
	});

	test("already-up-to-date from resolveConflicts retries merge without consuming mergeCycle.attempt", async () => {
		// First gh pr merge: conflict. resolveConflicts reports already-up-to-date.
		// Retry gh pr merge: succeeds. mergeCycle.attempt must not advance past 1.
		mockMergePr.mockImplementationOnce(async () => ({
			merged: false,
			alreadyMerged: false,
			conflict: true,
			error: null,
		}));
		mockMergePr.mockImplementationOnce(async () => ({
			merged: true,
			alreadyMerged: false,
			conflict: false,
			error: null,
		}));
		resolveConflictsResult = { kind: "already-up-to-date" };

		const wf = await advanceToMonitorCi();
		monitorResultResolve({ passed: true, timedOut: false, results: [] });
		await new Promise((r) => setTimeout(r, 60));

		expect(mockResolveConflicts).toHaveBeenCalledTimes(1);
		// Attempt was initialized to 1 on entry; already-up-to-date path does NOT
		// increment it.
		expect(wf.mergeCycle.attempt).toBe(1);
		// mergePr called twice: once for the initial attempt, once for the retry.
		expect(mockMergePr).toHaveBeenCalledTimes(2);
		expect(wf.status).toBe("completed");
	});

	test("already-up-to-date followed by a second conflict surfaces an error", async () => {
		// Both gh pr merge attempts report conflict; resolveConflicts is
		// already-up-to-date — no sane resolution exists locally.
		mergePrResult = { merged: false, alreadyMerged: false, conflict: true, error: null };
		resolveConflictsResult = { kind: "already-up-to-date" };

		const wf = await advanceToMonitorCi();
		monitorResultResolve({ passed: true, timedOut: false, results: [] });
		await new Promise((r) => setTimeout(r, 60));

		expect(wf.status).toBe("error");
		const mergePrIndex = wf.steps.findIndex((s) => s.name === "merge-pr");
		expect(wf.steps[mergePrIndex].error).toContain("GitHub continues to report a merge conflict");
		expect(mockMergePr).toHaveBeenCalledTimes(2);
		expect(wf.mergeCycle.attempt).toBe(1);
	});

	test("merge cycle exhausted after maxAttempts transitions to error", async () => {
		mergePrResult = { merged: false, alreadyMerged: false, conflict: true, error: null };

		const wf = await advanceToMonitorCi();
		wf.mergeCycle.attempt = 3; // Already at max

		monitorResultResolve({ passed: true, timedOut: false, results: [] });
		await new Promise((r) => setTimeout(r, 40));

		expect(wf.status).toBe("error");
		const mergePrIndex = wf.steps.findIndex((s) => s.name === "merge-pr");
		expect(wf.steps[mergePrIndex].error).toContain("3 resolution attempts");
	});

	test("sync-repo warning still completes workflow", async () => {
		syncRepoResult = {
			pulled: false,
			skipped: true,
			worktreeRemoved: true,
			warning: "Uncommitted changes",
		};

		const wf = await advanceToMonitorCi();
		monitorResultResolve({ passed: true, timedOut: false, results: [] });
		await new Promise((r) => setTimeout(r, 40));

		expect(wf.status).toBe("completed");
	});

	test("sync-repo sets worktreePath to null when worktree removed", async () => {
		syncRepoResult = { pulled: true, skipped: false, worktreeRemoved: true, warning: null };

		const wf = await advanceToMonitorCi();
		monitorResultResolve({ passed: true, timedOut: false, results: [] });
		await new Promise((r) => setTimeout(r, 40));

		expect(wf.worktreePath).toBeNull();
		expect(wf.status).toBe("completed");
	});

	test("merge-pr initializes mergeCycle.attempt on first entry", async () => {
		const wf = await advanceToMonitorCi();
		expect(wf.mergeCycle.attempt).toBe(0);

		monitorResultResolve({ passed: true, timedOut: false, results: [] });
		await new Promise((r) => setTimeout(r, 20));

		expect(wf.mergeCycle.attempt).toBe(1);
	});
});
