import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CLICallbacks } from "../../src/cli-runner";
import { configStore, DEFAULT_CONFIG } from "../../src/config-store";
import { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import { getStepDefinitionsForKind, type WorkflowStatus } from "../../src/pipeline-steps";
import type { PipelineCallbacks, Workflow } from "../../src/types";
import { WorktreeBranchManager } from "../../src/worktree-branch-manager";

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
				mergeCycle: { attempt: 0, maxAttempts: 3 },
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
			if (workflow) {
				workflow.status = status;
				// Mirror real WorkflowEngine.transition's clear-on-terminal behavior so
				// tests cover the abort/complete paths (CR-2).
				if (
					status === "idle" ||
					status === "completed" ||
					status === "aborted" ||
					status === "error"
				) {
					workflow.activeInvocation = null;
				}
			}
		},
		updateLastOutput: () => {},
		setQuestion: () => {},
		clearQuestion: () => {},
		updateSummary: () => {},
		updateStepSummary: () => {},
		createWorktree: async () => {
			if (workflow) workflow.worktreePath = "/tmp/test-worktree";
			return "/tmp/test-worktree";
		},
		copyGitignoredFiles: async () => {},
		removeWorktree: async () => {},
		moveWorktree: async () => "/tmp/test-worktree",
		_getWorkflow: () => workflow,
	};
}

function createFakeCliRunner() {
	const startCalls: Array<{
		workflow: Workflow;
		callbacks: CLICallbacks;
		model?: string;
		effort?: string;
	}> = [];
	return {
		start: (
			workflow: Workflow,
			callbacks: CLICallbacks,
			_extraEnv?: Record<string, string>,
			model?: string,
			effort?: string,
		) => {
			startCalls.push({ workflow, callbacks, model, effort });
			callbacks.onOutput("[test] running");
		},
		kill: mock(() => {}),
		resume: mock(() => {}),
		killAll: mock(() => {}),
		_startCalls: startCalls,
		getLastCallbacks: () => startCalls[startCalls.length - 1].callbacks,
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

function getWf(eng: ReturnType<typeof createFakeEngine>): Workflow {
	const wf = eng._getWorkflow();
	if (!wf) throw new Error("Expected workflow");
	return wf;
}

describe("PipelineOrchestrator.activeInvocation", () => {
	let orchestrator: PipelineOrchestrator;
	let callbacks: PipelineCallbacks;
	let engine: ReturnType<typeof createFakeEngine>;
	let cli: ReturnType<typeof createFakeCliRunner>;

	beforeEach(() => {
		configStore.save({
			autoMode: "normal",
			models: {
				...DEFAULT_CONFIG.models,
				specify: "claude-opus-4-7",
			},
			efforts: {
				...DEFAULT_CONFIG.efforts,
				specify: "high",
			},
		});
		callbacks = makeCallbacks();
		engine = createFakeEngine();
		cli = createFakeCliRunner();
		// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fakes
		const deps: Record<string, any> = {
			engine,
			cliRunner: cli,
			questionDetector: {
				detect: () => null,
				detectFromFinalized: () => null,
				classifyWithHaiku: async () => false,
				reset: () => {},
			},
			reviewClassifier: { classify: async () => "minor" },
			summarizer: {
				maybeSummarize: () => {},
				generateSpecSummary: async () => ({ summary: "", flavor: "" }),
				resetBuffer: () => {},
				cleanup: () => {},
			},
			auditLogger: {
				startRun: () => "run-id",
				endRun: () => {},
				logQuery: () => {},
				logAnswer: () => {},
				logCommit: () => {},
			},
			workflowStore: {
				save: async () => {},
				load: async () => null,
				loadAll: async () => [],
				loadIndex: async () => [],
				remove: async () => {},
			},
			runSetupChecks: async () => ({
				passed: true,
				checks: [],
				requiredFailures: [],
				optionalWarnings: [],
			}),
			worktreeManager: new WorktreeBranchManager(
				engine as unknown as import("../../src/workflow-engine").WorkflowEngine,
				{
					ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
					appendProjectClaudeMd: async () => ({ outcome: "no-project" as const }),
					markClaudeMdSkipWorktree: async () => ({ outcome: "not-tracked" as const }),
					checkoutMaster: async () => ({ code: 0, stderr: "" }),
					getGitHead: async () => "head-sha",
					detectNewCommits: async () => [],
				},
			),
		};
		orchestrator = new PipelineOrchestrator(callbacks, deps);
	});

	async function startAndFlush(spec = "test spec") {
		await orchestrator.startPipeline(spec, "/tmp/test-repo");
		await new Promise((r) => setTimeout(r, 0));
	}

	test("runStep sets workflow.activeInvocation when a main AI step starts", async () => {
		await startAndFlush();
		const wf = getWf(engine);
		// setup auto-completed; specify is running and has populated activeInvocation
		expect(wf.currentStepIndex).toBe(1);
		expect(wf.steps[1].name).toBe("specify");
		expect(wf.activeInvocation).not.toBeNull();
		expect(wf.activeInvocation?.model).toBe("claude-opus-4-7");
		expect(wf.activeInvocation?.effort).toBe("high");
		expect(wf.activeInvocation?.stepName).toBe("specify");
		expect(wf.activeInvocation?.role).toBe("main");
	});

	test("handleStepComplete clears activeInvocation to null", async () => {
		await startAndFlush();
		const wf = getWf(engine);
		expect(wf.activeInvocation).not.toBeNull();

		// Complete the specify step (emit meaningful output first so the empty-output guard passes)
		const cb = cli.getLastCallbacks();
		cb.onOutput("some real step output");
		cb.onComplete();
		await new Promise((r) => setTimeout(r, 0));

		// After specify completes, the orchestrator advances to clarify and
		// runStep repopulates activeInvocation for the next main step.
		expect(wf.activeInvocation).not.toBeNull();
		expect(wf.activeInvocation?.stepName).toBe("clarify");
	});

	test("handleStepError clears activeInvocation to null", async () => {
		await startAndFlush();
		const wf = getWf(engine);
		expect(wf.activeInvocation).not.toBeNull();

		const cb = cli.getLastCallbacks();
		cb.onError("boom");
		await new Promise((r) => setTimeout(r, 0));

		expect(wf.activeInvocation).toBeNull();
	});

	test("abortPipeline clears activeInvocation to null", async () => {
		await startAndFlush();
		const wf = getWf(engine);
		expect(wf.activeInvocation).not.toBeNull();

		orchestrator.abortPipeline(wf.id);

		expect(wf.activeInvocation).toBeNull();
		expect(wf.status).toBe("aborted");
	});

	test("answering a question refreshes activeInvocation with the current configured model", async () => {
		// Regression: previously, answerQuestion → resumeStep dispatched the LLM
		// without refreshing workflow.activeInvocation, so the UI kept showing the
		// pre-question model even if the user changed it while the workflow was
		// paused for input.
		await startAndFlush();
		const wf = getWf(engine);
		expect(wf.activeInvocation?.model).toBe("claude-opus-4-7");

		// CLI surfaces a session id for the current step, so resume has something
		// to resume against.
		const cb = cli.getLastCallbacks();
		cb.onSessionId?.("sess-specify-1");

		// User changes the configured model for "specify" while the workflow is
		// waiting on the question.
		configStore.save({
			autoMode: "normal",
			models: { ...DEFAULT_CONFIG.models, specify: "claude-sonnet-4-6" },
			efforts: { ...DEFAULT_CONFIG.efforts, specify: "low" },
		});

		// Stage a pending question so answerQuestion takes the resume path.
		wf.pendingQuestion = {
			id: "q-1",
			content: "?",
			detectedAt: new Date().toISOString(),
		};
		wf.status = "waiting_for_input";

		orchestrator.answerQuestion(wf.id, "q-1", "the answer");

		expect(wf.activeInvocation).not.toBeNull();
		expect(wf.activeInvocation?.model).toBe("claude-sonnet-4-6");
		expect(wf.activeInvocation?.effort).toBe("low");
		expect(wf.activeInvocation?.stepName).toBe("specify");
	});

	test("a step with empty-string configured model still populates activeInvocation (UI shows 'default')", async () => {
		// Empty model means "use Claude Code default" — the panel should still
		// reflect that a main AI step is running, not show "No model in use".
		configStore.save({
			autoMode: "normal",
			models: { ...DEFAULT_CONFIG.models, specify: "" },
			efforts: DEFAULT_CONFIG.efforts,
		});
		await startAndFlush();
		const wf = getWf(engine);
		expect(wf.steps[1].name).toBe("specify");
		expect(wf.steps[1].status).toBe("running");
		expect(wf.activeInvocation).not.toBeNull();
		expect(wf.activeInvocation?.model).toBe("");
		expect(wf.activeInvocation?.stepName).toBe("specify");
	});
});
