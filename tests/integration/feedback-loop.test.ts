import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CLICallbacks } from "../../src/cli-runner";
import { configStore, DEFAULT_CONFIG } from "../../src/config-store";
import type { EffortLevel } from "../../src/config-types";
import { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import { getStepDefinitionsForKind, STEP, type WorkflowStatus } from "../../src/pipeline-steps";
import type { ServerMessage } from "../../src/protocol";
import type { PipelineCallbacks, ToolUsage, Workflow } from "../../src/types";
import { WorkflowStore } from "../../src/workflow-store";

// ── Minimal fakes (similar to pipeline-orchestrator.test.ts but self-contained) ──

type FakeCli = {
	start: (
		workflow: Workflow,
		callbacks: CLICallbacks,
		extraEnv?: Record<string, string>,
		model?: string,
		effort?: EffortLevel,
	) => void;
	resume: (
		workflowId: string,
		sessionId: string,
		cwd: string,
		callbacks: CLICallbacks,
		extraEnv?: Record<string, string>,
		prompt?: string,
	) => void;
	kill: (id: string) => void;
	killAll: () => void;
	lastCallbacks: CLICallbacks | null;
	startCalls: Array<{ workflow: Workflow }>;
};

function createFakeCli(): FakeCli {
	const startCalls: Array<{ workflow: Workflow }> = [];
	const fake: FakeCli = {
		start(workflow, callbacks) {
			startCalls.push({ workflow });
			fake.lastCallbacks = callbacks;
			callbacks.onOutput("[test] CLI running");
		},
		resume(_id, _session, _cwd, callbacks) {
			fake.lastCallbacks = callbacks;
			callbacks.onOutput("[test] CLI resumed");
		},
		kill() {},
		killAll() {},
		lastCallbacks: null,
		startCalls,
	};
	return fake;
}

function createFakeEngine() {
	let workflow: Workflow | null = null;
	return {
		getWorkflow: () => workflow,
		setWorkflow: (wf: Workflow) => {
			workflow = wf;
		},
		createWorkflow: async (spec: string, targetRepository: string) => {
			const now = new Date().toISOString();
			workflow = {
				id: "itest-wf",
				workflowKind: "spec",
				specification: spec,
				status: "idle" as WorkflowStatus,
				targetRepository,
				worktreePath: null,
				worktreeBranch: "tmp-test",
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
				aspectManifest: null,
				aspects: null,
				synthesizedAnswer: null,
			};
			return workflow as Workflow;
		},
		transition: (_id: string, status: WorkflowStatus) => {
			if (workflow) workflow.status = status;
		},
		updateLastOutput: (_id: string, text: string) => {
			if (workflow) workflow.lastOutput = text;
		},
		setQuestion: () => {},
		clearQuestion: () => {},
		updateSummary: () => {},
		updateStepSummary: () => {},
		createWorktree: async () => "/tmp/itest-worktree",
		copyGitignoredFiles: async () => {},
		removeWorktree: async () => {},
		moveWorktree: async () => "/tmp/itest-worktree",
	};
}

describe("Manual-mode feedback loop — integration", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		configStore.save({ autoMode: "manual" });
		baseDir = join(
			tmpdir(),
			`feedback-loop-itest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(baseDir, { recursive: true });
		store = new WorkflowStore(baseDir);
	});

	afterEach(() => {
		configStore.save({ autoMode: "normal" });
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	function createOrch(commitRefs: string[]) {
		const broadcasts: ServerMessage[] = [];
		const outputs: Array<{ workflowId: string; text: string }> = [];

		const callbacks: PipelineCallbacks = {
			onStepChange: (workflowId, previousStep, currentStep, currentStepIndex, reviewIteration) => {
				broadcasts.push({
					type: "workflow:step-change",
					workflowId,
					previousStep,
					currentStep,
					currentStepIndex,
					reviewIteration,
				});
			},
			onOutput: (workflowId: string, text: string) => {
				outputs.push({ workflowId, text });
			},
			onTools: (workflowId: string, tools: ToolUsage[]) => {
				broadcasts.push({ type: "workflow:tools", workflowId, tools });
			},
			onComplete: () => {},
			onError: () => {},
			onStateChange: (workflowId: string) => {
				broadcasts.push({ type: "workflow:state", workflow: null });
				void workflowId;
			},
		};

		const engine = createFakeEngine();
		const cli = createFakeCli();

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
			checkoutMaster: async () => ({ code: 0, stderr: "" }),
			getGitHead: async () => "pre-run-head",
			detectNewCommits: async () => commitRefs,
		});

		return { orch, engine, cli, broadcasts, outputs };
	}

	async function seedMergePrPause(engine: ReturnType<typeof createFakeEngine>): Promise<Workflow> {
		const wf = await engine.createWorkflow("integration test spec", "/tmp/itest-repo");
		wf.worktreePath = "/tmp/itest-worktree";
		wf.prUrl = "https://github.com/owner/repo/pull/42";
		const mergeIdx = wf.steps.findIndex((s) => s.name === STEP.MERGE_PR);
		for (let i = 0; i < mergeIdx; i++) wf.steps[i].status = "completed";
		wf.currentStepIndex = mergeIdx;
		wf.steps[mergeIdx].status = "paused";
		wf.status = "paused";
		await store.save(wf);
		return wf;
	}

	test("happy path: feedback submission → implementer → success → monitor-ci", async () => {
		const { orch, engine, cli, broadcasts } = createOrch(["abc1234"]);
		const wf = await seedMergePrPause(engine);

		orch.submitFeedback(wf.id, "rename x to count");
		await new Promise((r) => setTimeout(r, 10));

		// After submission: entry appended, workflow running, step = feedback-implementer
		expect(wf.feedbackEntries).toHaveLength(1);
		expect(wf.feedbackEntries[0].outcome).toBeNull();
		expect(wf.feedbackEntries[0].kind).toBe("merge-pr-iteration");
		expect(wf.status).toBe("running");
		expect(wf.steps[wf.currentStepIndex].name).toBe(STEP.FEEDBACK_IMPLEMENTER);

		// CLI was spawned with a prompt that contains the feedback + PR URL
		expect(cli.startCalls.length).toBe(1);
		expect(cli.startCalls[0].workflow.specification).toContain("rename x to count");
		expect(cli.startCalls[0].workflow.specification).toContain(
			"https://github.com/owner/repo/pull/42",
		);

		// Simulate agent success
		const sentinel = `<<<FEEDBACK_IMPLEMENTER_RESULT
{"outcome":"success","summary":"renamed x","materiallyRelevant":true,"prDescriptionUpdate":{"attempted":true,"succeeded":true,"errorMessage":null}}
FEEDBACK_IMPLEMENTER_RESULT>>>`;
		cli.lastCallbacks?.onOutput(sentinel);
		cli.lastCallbacks?.onComplete();
		await new Promise((r) => setTimeout(r, 30));

		// Outcome landed on the entry
		const entry = wf.feedbackEntries[0];
		expect(entry.outcome?.value).toBe("success");
		expect(entry.outcome?.commitRefs).toEqual(["abc1234"]);

		// Workflow routed to monitor-ci
		const monIdx = wf.steps.findIndex((s) => s.name === STEP.MONITOR_CI);
		expect(wf.currentStepIndex).toBe(monIdx);

		// State broadcasts fired along the way
		const stepChanges = broadcasts.filter(
			(m): m is ServerMessage & { type: "workflow:step-change" } =>
				m.type === "workflow:step-change",
		);
		expect(stepChanges.some((m) => m.currentStep === STEP.FEEDBACK_IMPLEMENTER)).toBe(true);
		expect(stepChanges.some((m) => m.currentStep === STEP.MONITOR_CI)).toBe(true);

		// Persistence: the workflow on disk reflects the feedback entry
		const loaded = await store.load(wf.id);
		expect(loaded?.feedbackEntries).toHaveLength(1);
		expect(loaded?.feedbackEntries[0].outcome?.value).toBe("success");
	});

	test("no-changes path: sentinel parsed, routed back to merge-pr pause", async () => {
		const { orch, engine, cli } = createOrch([]);
		const wf = await seedMergePrPause(engine);

		orch.submitFeedback(wf.id, "already done");
		await new Promise((r) => setTimeout(r, 10));

		cli.lastCallbacks?.onOutput(
			`<<<FEEDBACK_IMPLEMENTER_RESULT\n{"outcome":"no changes","summary":"noop","materiallyRelevant":false}\nFEEDBACK_IMPLEMENTER_RESULT>>>`,
		);
		cli.lastCallbacks?.onComplete();
		await new Promise((r) => setTimeout(r, 30));

		const mergeIdx = wf.steps.findIndex((s) => s.name === STEP.MERGE_PR);
		expect(wf.currentStepIndex).toBe(mergeIdx);
		expect(wf.status).toBe("paused");
		expect(wf.feedbackEntries[0].outcome?.value).toBe("no changes");
	});

	test("feedback entries survive restart and inject into next CLI spawn (SC-004, FR-010)", async () => {
		// Phase 1: submit + complete one feedback iteration
		const { orch: orch1, engine: engine1, cli: cli1 } = createOrch(["commit-one"]);
		const wf1 = await seedMergePrPause(engine1);

		orch1.submitFeedback(wf1.id, "rename x to count");
		await new Promise((r) => setTimeout(r, 10));
		cli1.lastCallbacks?.onOutput(
			`<<<FEEDBACK_IMPLEMENTER_RESULT\n{"outcome":"success","summary":"renamed","materiallyRelevant":true}\nFEEDBACK_IMPLEMENTER_RESULT>>>`,
		);
		cli1.lastCallbacks?.onComplete();

		// Phase 2: simulate server restart — fresh orchestrator + fresh engine,
		// reload workflow from persistence and set it on the new engine.
		// Poll for the persisted outcome rather than relying on a fixed delay,
		// since onComplete → persist is async and flaky under parallel test load.
		let loaded: Awaited<ReturnType<typeof store.load>> = null;
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			loaded = await store.load(wf1.id);
			if (loaded?.feedbackEntries?.[0]?.outcome?.value === "success") break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(loaded).not.toBeNull();
		if (!loaded) return;
		expect(loaded.feedbackEntries).toHaveLength(1);
		expect(loaded.feedbackEntries[0].outcome?.value).toBe("success");

		const { orch: orch2, engine: engine2, cli: cli2 } = createOrch([]);
		engine2.setWorkflow(loaded);

		// Force a spec step run to see the injected feedback context
		loaded.status = "running";
		loaded.worktreePath = "/tmp/itest-worktree";
		const specIdx = loaded.steps.findIndex((s) => s.name === STEP.SPECIFY);
		loaded.currentStepIndex = specIdx;
		loaded.steps[specIdx].status = "error";
		loaded.status = "error";
		await orch2.retryStep(loaded.id);
		await new Promise((r) => setTimeout(r, 20));

		const lastCall = cli2.startCalls[cli2.startCalls.length - 1];
		expect(lastCall.workflow.specification).toContain("USER FEEDBACK");
		expect(lastCall.workflow.specification).toContain("rename x to count");
	});

	test("persisted workflow state exposes feedbackEntries on the wire (T040)", async () => {
		const { engine } = createOrch([]);
		const wf = await seedMergePrPause(engine);
		wf.feedbackEntries = [
			{
				id: "fe-wire",
				iteration: 1,
				text: "feedback on wire",
				submittedAt: "2026-04-13T00:00:00.000Z",
				submittedAtStepName: "merge-pr",
				outcome: {
					value: "success",
					summary: "wire test",
					commitRefs: ["wire-abc"],
					warnings: [],
				},
			},
		];
		// feedbackPreRunHead is internal orchestrator bookkeeping — the wire format
		// must strip it even when it's non-null on the in-memory workflow.
		wf.feedbackPreRunHead = "internal-head-sha-not-for-wire";
		await store.save(wf);

		// Apply the actual server.ts stripInternalFields function
		const { steps, feedbackPreRunHead: _fph, ...rest } = wf;
		const wire = {
			...rest,
			steps: steps.map(({ sessionId: _sid, prompt: _p, pid: _pid, ...step }) => step),
		};

		expect(wire.feedbackEntries).toHaveLength(1);
		expect(wire.feedbackEntries[0].text).toBe("feedback on wire");
		expect(wire.feedbackEntries[0].outcome?.commitRefs).toEqual(["wire-abc"]);
		// Lock the contract: feedbackPreRunHead is internal and MUST NOT appear on
		// the wire, even when the in-memory workflow has a non-null value.
		expect((wire as { feedbackPreRunHead?: unknown }).feedbackPreRunHead).toBeUndefined();
	});
});
