import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit-logger";
import type { CLICallbacks } from "../../src/cli-runner";
import { configStore, DEFAULT_CONFIG } from "../../src/config-store";
import type { EffortLevel } from "../../src/config-types";
import { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import { getStepDefinitionsForKind, STEP, type WorkflowStatus } from "../../src/pipeline-steps";
import type { PipelineCallbacks, ToolUsage, Workflow } from "../../src/types";
import { WorkflowStore } from "../../src/workflow-store";

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
		model?: string,
		effort?: EffortLevel,
	) => void;
	kill: (id: string) => void;
	killAll: () => void;
	resumeCalls: Array<{ workflowId: string; sessionId: string; prompt?: string }>;
	startCalls: Array<{ workflow: Workflow }>;
	failNextSpawn: boolean;
	lastCallbacks: CLICallbacks | null;
};

function createFakeCli(): FakeCli {
	const fake: FakeCli = {
		start(workflow, callbacks) {
			fake.startCalls.push({ workflow });
			fake.lastCallbacks = callbacks;
			callbacks.onOutput("[test] CLI start");
		},
		resume(workflowId, sessionId, _cwd, callbacks, _env, prompt) {
			if (fake.failNextSpawn) {
				fake.failNextSpawn = false;
				queueMicrotask(() => callbacks.onError("simulated spawn failure"));
				return;
			}
			fake.resumeCalls.push({ workflowId, sessionId, prompt });
			fake.lastCallbacks = callbacks;
			callbacks.onOutput("[test] CLI resumed");
		},
		kill() {},
		killAll() {},
		resumeCalls: [],
		startCalls: [],
		failNextSpawn: false,
		lastCallbacks: null,
	};
	return fake;
}

function createFakeEngine(workflowKind: "spec" | "quick-fix" = "spec") {
	let workflow: Workflow | null = null;
	return {
		getWorkflow: () => workflow,
		setWorkflow: (wf: Workflow) => {
			workflow = wf;
		},
		createWorkflow: async (spec: string, targetRepository: string) => {
			const now = new Date().toISOString();
			workflow = {
				id: "wf-feedback-test",
				workflowKind,
				specification: spec,
				status: "idle" as WorkflowStatus,
				targetRepository,
				worktreePath: null,
				worktreeBranch: "tmp-feedback",
				featureBranch: null,
				summary: "",
				stepSummary: "",
				flavor: "",
				pendingQuestion: null,
				lastOutput: "",
				steps: getStepDefinitionsForKind(workflowKind).map((def) => ({
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
		createWorktree: async () => "/tmp/feedback-itest-worktree",
		copyGitignoredFiles: async () => {},
		removeWorktree: async () => {},
		moveWorktree: async () => "/tmp/feedback-itest-worktree",
	};
}

describe("Resume-with-feedback — integration", () => {
	let baseDir: string;
	let auditDir: string;
	let store: WorkflowStore;
	let auditLogger: AuditLogger;

	beforeEach(() => {
		baseDir = join(
			tmpdir(),
			`workflow-feedback-itest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		auditDir = join(baseDir, "audit");
		mkdirSync(baseDir, { recursive: true });
		mkdirSync(auditDir, { recursive: true });
		store = new WorkflowStore(baseDir);
		auditLogger = new AuditLogger({ auditDir });
		configStore.save({ autoMode: "normal" });
	});

	afterEach(() => {
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {}
	});

	function createOrch() {
		const broadcasts: Array<{ type: string; [k: string]: unknown }> = [];
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
			onOutput: () => {},
			onTools: (workflowId: string, tools: ToolUsage[]) => {
				broadcasts.push({ type: "workflow:tools", workflowId, tools });
			},
			onComplete: () => {},
			onError: () => {},
			onStateChange: (workflowId: string) => {
				broadcasts.push({ type: "workflow:state", workflowId });
			},
		};

		const engine = createFakeEngine();
		const cli = createFakeCli();

		const orch = new PipelineOrchestrator(callbacks, {
			engine: engine as unknown as import("../../src/workflow-engine").WorkflowEngine,
			cliRunner: cli as unknown as import("../../src/cli-runner").CLIRunner,
			workflowStore: store,
			auditLogger,
			runSetupChecks: async () => ({
				passed: true,
				checks: [],
				requiredFailures: [],
				optionalWarnings: [],
			}),
			ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
			checkoutMaster: async () => ({ code: 0, stderr: "" }),
			getGitHead: async () => "head-sha",
			detectNewCommits: async () => [],
		});

		return { orch, engine, cli, broadcasts };
	}

	async function seedPausedWithSession(
		engine: ReturnType<typeof createFakeEngine>,
		stepName = STEP.IMPLEMENT,
	): Promise<Workflow> {
		const wf = await engine.createWorkflow("integration spec", "/tmp/feedback-repo");
		wf.worktreePath = "/tmp/feedback-itest-worktree";
		const stepIdx = wf.steps.findIndex((s) => s.name === stepName);
		for (let i = 0; i < stepIdx; i++) wf.steps[i].status = "completed";
		wf.currentStepIndex = stepIdx;
		wf.steps[stepIdx].status = "paused";
		wf.steps[stepIdx].sessionId = "sess-abc-123";
		wf.status = "paused";
		await store.save(wf);
		return wf;
	}

	function readAuditLines(workflowSafeName: string): Array<Record<string, unknown>> {
		const file = readdirSync(auditDir).find((f) => f.includes(workflowSafeName));
		if (!file) return [];
		return readFileSync(join(auditDir, file), "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	}

	test("happy path: resume-with-feedback persists kind, transitions paused→running, preserves currentStepIndex, emits one audit event (T007)", async () => {
		const { orch, engine, cli } = createOrch();
		const wf = await seedPausedWithSession(engine, STEP.IMPLEMENT);
		const stepIdxBefore = wf.currentStepIndex;

		// startPipeline-like seeding to populate currentAuditRunId is bypassed
		// here. Drive submitResumeWithFeedback directly via the resumeStep path.
		// To make audit emission observable, give the orchestrator a runId.
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).currentAuditRunId = auditLogger.startRun("test-pipeline", wf.worktreeBranch);
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).pipelineName = "test-pipeline";

		const result = orch.submitResumeWithFeedback(wf.id, "  please add a null-check  ");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(wf.feedbackEntries).toHaveLength(1);
		expect(wf.feedbackEntries[0].kind).toBe("resume-with-feedback");
		expect(wf.feedbackEntries[0].text).toBe("please add a null-check");
		expect(wf.status).toBe("running");
		expect(wf.currentStepIndex).toBe(stepIdxBefore);

		// CLI was resumed with the literal injected prompt
		expect(cli.resumeCalls).toHaveLength(1);
		expect(cli.resumeCalls[0].sessionId).toBe("sess-abc-123");
		expect(cli.resumeCalls[0].prompt).toBe(
			"Resume what you just did. Also consider this: please add a null-check",
		);

		// Audit event present, content=null, metadata-only
		const events = readAuditLines("test-pipeline");
		const submitted = events.filter((e) => e.eventType === "feedback_submitted_resume");
		expect(submitted).toHaveLength(1);
		expect(submitted[0].content).toBeNull();
		const meta = submitted[0].metadata as Record<string, unknown>;
		expect(meta.stepIndex).toBe(stepIdxBefore);
		expect(meta.feedbackLengthChars).toBe("please add a null-check".length);
	});

	test("post-transition spawn failure: status ends in error, FeedbackEntry retained, audit event still emitted (T008, FR-013)", async () => {
		const { orch, engine, cli } = createOrch();
		const wf = await seedPausedWithSession(engine, STEP.IMPLEMENT);
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).currentAuditRunId = auditLogger.startRun("post-fail", wf.worktreeBranch);
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).pipelineName = "post-fail";

		cli.failNextSpawn = true;
		const result = orch.submitResumeWithFeedback(wf.id, "do thing X");
		// Allow microtasks so onError handler can transition to errored.
		await new Promise((r) => setTimeout(r, 10));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Async spawn failures are signaled via the standard workflow-state
		// broadcast (status → "error"), not via the response envelope: the
		// orchestrator returns before the queueMicrotask onError fires, so the
		// initial response is a plain success (no warning, no statusAfter).
		expect(result.warning).toBeUndefined();
		expect(result.workflowStatusAfter).toBeUndefined();
		// The persisted entry is retained
		expect(wf.feedbackEntries).toHaveLength(1);
		expect(wf.feedbackEntries[0].kind).toBe("resume-with-feedback");
		// Audit event was emitted (ER-003)
		const events = readAuditLines("post-fail");
		const submitted = events.filter((e) => e.eventType === "feedback_submitted_resume");
		expect(submitted).toHaveLength(1);
		// Workflow ended in error after the failure callback fired
		expect(wf.status).toBe("error");
	});

	test("stale-state rejection: workflow not paused → reject, no entry, no audit (T009, FR-007)", async () => {
		const { orch, engine } = createOrch();
		const wf = await seedPausedWithSession(engine, STEP.IMPLEMENT);
		wf.status = "running";
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).currentAuditRunId = auditLogger.startRun("stale-reject", wf.worktreeBranch);
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).pipelineName = "stale-reject";

		const result = orch.submitResumeWithFeedback(wf.id, "should be rejected");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("workflow-not-paused");
		expect(result.currentState.status).toBe("running");

		expect(wf.feedbackEntries).toHaveLength(0);
		const events = readAuditLines("stale-reject");
		const submitted = events.filter((e) => e.eventType === "feedback_submitted_resume");
		expect(submitted).toHaveLength(0);
	});

	test("10k-char cap server-side: rejects with reason text-length, no persistence, no audit (T010, FR-014)", async () => {
		const { orch, engine } = createOrch();
		const wf = await seedPausedWithSession(engine, STEP.IMPLEMENT);
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).currentAuditRunId = auditLogger.startRun("len-cap", wf.worktreeBranch);
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).pipelineName = "len-cap";

		const oversized = "x".repeat(10001);
		const result = orch.submitResumeWithFeedback(wf.id, oversized);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("text-length");

		expect(wf.feedbackEntries).toHaveLength(0);
		const events = readAuditLines("len-cap");
		expect(events.filter((e) => e.eventType === "feedback_submitted_resume")).toHaveLength(0);
	});

	test("step-not-resumable: paused without sessionId → reject (T011, FR-001)", async () => {
		const { orch, engine } = createOrch();
		const wf = await seedPausedWithSession(engine, STEP.IMPLEMENT);
		wf.steps[wf.currentStepIndex].sessionId = null;
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).currentAuditRunId = auditLogger.startRun("no-session", wf.worktreeBranch);
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).pipelineName = "no-session";

		const result = orch.submitResumeWithFeedback(wf.id, "any text");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("step-not-resumable");

		expect(wf.feedbackEntries).toHaveLength(0);
		const events = readAuditLines("no-session");
		expect(events.filter((e) => e.eventType === "feedback_submitted_resume")).toHaveLength(0);
	});

	test("special characters pass through verbatim into the injected prompt (T012, Edge Cases §3, FR-003)", async () => {
		const { orch, engine, cli } = createOrch();
		const wf = await seedPausedWithSession(engine, STEP.IMPLEMENT);
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).currentAuditRunId = auditLogger.startRun("special", wf.worktreeBranch);
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).pipelineName = "special";

		const tricky = "line1\nline2 with \"quotes\" and `backticks` and ${literal} and 'single'";
		const result = orch.submitResumeWithFeedback(wf.id, tricky);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(cli.resumeCalls).toHaveLength(1);
		expect(cli.resumeCalls[0].prompt).toBe(
			`Resume what you just did. Also consider this: ${tricky}`,
		);
		expect(wf.feedbackEntries[0].text).toBe(tricky);
	});
});
