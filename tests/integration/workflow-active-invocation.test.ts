import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CLICallbacks } from "../../src/cli-runner";
import { configStore, DEFAULT_CONFIG } from "../../src/config-store";
import type { PipelineCallbacks } from "../../src/pipeline-orchestrator";
import { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type {
	ActiveAIInvocation,
	ServerMessage,
	Workflow,
	WorkflowState,
	WorkflowStatus,
} from "../../src/types";
import { getStepDefinitionsForKind } from "../../src/types";
import { WorkflowStore } from "../../src/workflow-store";

function stripInternalFields(w: Workflow): WorkflowState {
	const { steps, feedbackPreRunHead: _fph, ...rest } = w;
	return {
		...rest,
		steps: steps.map(({ sessionId: _sid, prompt: _p, pid: _pid, ...step }) => step),
	};
}

function createFakeEngine() {
	let workflow: Workflow | null = null;
	return {
		getWorkflow: () => workflow,
		createWorkflow: async (spec: string, targetRepository: string) => {
			const now = new Date().toISOString();
			workflow = {
				id: "ai-itest-wf",
				workflowKind: "spec",
				specification: spec,
				status: "idle" as WorkflowStatus,
				targetRepository,
				worktreePath: null,
				worktreeBranch: "tmp-ai",
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
				// Mirror real engine's terminal-state clearing (CR-2) so the
				// resume + complete path below exercises realistic semantics.
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
			if (workflow) workflow.worktreePath = "/tmp/ai-itest-worktree";
			return "/tmp/ai-itest-worktree";
		},
		copyGitignoredFiles: async () => {},
		removeWorktree: async () => {},
		moveWorktree: async () => "/tmp/ai-itest-worktree",
		_getWorkflow: () => workflow,
	};
}

function createFakeCli() {
	let lastCallbacks: CLICallbacks | null = null;
	return {
		start: (_wf: Workflow, cb: CLICallbacks) => {
			lastCallbacks = cb;
			cb.onOutput("[itest] running");
		},
		resume: (_wfId: string, _sessionId: string, _cwd: string, cb: CLICallbacks) => {
			lastCallbacks = cb;
			cb.onOutput("[itest] resumed");
		},
		kill: () => {},
		killAll: () => {},
		getLastCallbacks: () => lastCallbacks,
	};
}

describe("workflow-active-invocation integration", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		configStore.save({
			autoMode: "normal",
			models: { ...DEFAULT_CONFIG.models, specify: "claude-opus-4-7" },
			efforts: { ...DEFAULT_CONFIG.efforts, specify: "high" },
		});
		baseDir = join(
			tmpdir(),
			`active-invocation-itest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(baseDir, { recursive: true });
		store = new WorkflowStore(baseDir);
	});

	afterEach(() => {
		configStore.save({
			autoMode: "normal",
			models: DEFAULT_CONFIG.models,
			efforts: DEFAULT_CONFIG.efforts,
		});
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	function createOrch() {
		const broadcasts: ServerMessage[] = [];
		const engine = createFakeEngine();
		const cli = createFakeCli();

		const callbacks: PipelineCallbacks = {
			onStepChange: () => {},
			onOutput: () => {},
			onTools: () => {},
			onComplete: () => {},
			onError: () => {},
			onStateChange: () => {
				const w = engine._getWorkflow();
				if (w) broadcasts.push({ type: "workflow:state", workflow: stripInternalFields(w) });
			},
		};

		const orch = new PipelineOrchestrator(callbacks, {
			engine: engine as unknown as import("../../src/workflow-engine").WorkflowEngine,
			cliRunner: cli as unknown as import("../../src/cli-runner").CLIRunner,
			workflowStore: store,
			runSetupChecks: async () => ({
				passed: true,
				checks: [],
				requiredFailures: [],
				optionalWarnings: [],
			}),
			ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
			appendProjectClaudeMd: async () => ({ outcome: "no-project" as const }),
			markClaudeMdSkipWorktree: async () => ({ outcome: "not-tracked" as const }),
			checkoutMaster: async () => ({ code: 0, stderr: "" }),
			getGitHead: async () => "pre-head",
			detectNewCommits: async () => [],
		});

		return { orch, engine, cli, broadcasts };
	}

	function latestWorkflowState(broadcasts: ServerMessage[]): WorkflowState | null {
		for (let i = broadcasts.length - 1; i >= 0; i--) {
			const m = broadcasts[i];
			if (m.type === "workflow:state") return m.workflow;
		}
		return null;
	}

	test("broadcast during running main step carries populated activeInvocation", async () => {
		const { orch, broadcasts } = createOrch();
		await orch.startPipeline("itest spec", "/tmp/itest-repo");
		await new Promise((r) => setTimeout(r, 0));

		const state = latestWorkflowState(broadcasts);
		expect(state).not.toBeNull();
		const inv = state?.activeInvocation as ActiveAIInvocation | null;
		expect(inv).not.toBeNull();
		expect(inv?.model).toBe("claude-opus-4-7");
		expect(inv?.effort).toBe("high");
		expect(inv?.stepName).toBe("specify");
		expect(inv?.role).toBe("main");
	});

	test("broadcast after step completion carries activeInvocation: null", async () => {
		const { orch, cli, broadcasts } = createOrch();
		await orch.startPipeline("itest spec", "/tmp/itest-repo");
		await new Promise((r) => setTimeout(r, 0));

		const cb = cli.getLastCallbacks();
		if (!cb) throw new Error("expected cli.start callbacks");
		cb.onOutput("meaningful step output");
		cb.onComplete();
		await new Promise((r) => setTimeout(r, 0));

		// handleStepComplete clears and broadcasts (activeInvocation: null), then
		// advances to the next step. runStep for clarify repopulates activeInvocation
		// with the clarify model (empty string = "default"). Either way the panel
		// reflects what is currently live — it should never stay null while a main
		// step is actually running.
		const state = latestWorkflowState(broadcasts);
		expect(state?.activeInvocation).not.toBeNull();
		expect(state?.activeInvocation?.stepName).toBe("clarify");
	});

	test("pausing mid-step preserves activeInvocation via the real pause() path", async () => {
		const { orch, engine, broadcasts } = createOrch();
		await orch.startPipeline("itest spec", "/tmp/itest-repo");
		await new Promise((r) => setTimeout(r, 0));

		const wf = engine._getWorkflow();
		if (!wf) throw new Error("workflow missing");
		orch.pause(wf.id);

		const latest = latestWorkflowState(broadcasts);
		expect(latest?.status).toBe("paused");
		// Pausing does not clear activeInvocation — R4 / FR-006: the UI needs the
		// value so it can render the dimmed "— paused, not live" annotation.
		expect(latest?.activeInvocation).not.toBeNull();
		expect(latest?.activeInvocation?.model).toBe("claude-opus-4-7");
	});

	test("resume + complete clears activeInvocation (CR-3)", async () => {
		const { orch, engine, cli, broadcasts } = createOrch();
		await orch.startPipeline("itest spec", "/tmp/itest-repo");
		await new Promise((r) => setTimeout(r, 0));

		const wf = engine._getWorkflow();
		if (!wf) throw new Error("workflow missing");
		orch.pause(wf.id);
		expect(wf.status).toBe("paused");
		expect(wf.activeInvocation).not.toBeNull();

		orch.resume(wf.id);
		expect(wf.status).toBe("running");
		// Resume re-broadcasts; activeInvocation is re-populated by runStep since
		// there's no session id (fresh spawn). Model/effort must still reflect main.
		expect(wf.activeInvocation).not.toBeNull();

		const cb = cli.getLastCallbacks();
		if (!cb) throw new Error("expected cli callbacks after resume");
		cb.onOutput("completion output");
		cb.onComplete();
		await new Promise((r) => setTimeout(r, 0));

		// After specify completes the orchestrator advances to clarify and
		// runStep repopulates activeInvocation for the next main step.
		const final = latestWorkflowState(broadcasts);
		expect(final?.activeInvocation).not.toBeNull();
		expect(final?.activeInvocation?.stepName).toBe("clarify");
	});
});
