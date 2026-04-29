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

/**
 * T023 (User Story 2): Plain Resume must remain byte-for-byte unchanged.
 *
 * Asserts that calling `orch.resume(workflowId)` on a paused workflow with a
 * captured CLI session does NOT inject the resume-with-feedback prompt, does
 * NOT persist a FeedbackEntry, and does NOT emit a `feedback_submitted_resume`
 * audit event. The non-feedback resume path is the regression contract for
 * SC-002.
 */

type FakeCli = {
	start: (workflow: Workflow, callbacks: CLICallbacks) => void;
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
	resumeCalls: Array<{ workflowId: string; sessionId: string; prompt: string | undefined }>;
};

function createFakeCli(): FakeCli {
	const fake: FakeCli = {
		start(_workflow, callbacks) {
			callbacks.onOutput("[test] CLI start");
		},
		resume(workflowId, sessionId, _cwd, callbacks, _env, prompt) {
			fake.resumeCalls.push({ workflowId, sessionId, prompt });
			callbacks.onOutput("[test] CLI resumed (plain)");
		},
		kill() {},
		killAll() {},
		resumeCalls: [],
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
				id: "wf-resume-regression",
				workflowKind: "spec",
				specification: spec,
				status: "idle" as WorkflowStatus,
				targetRepository,
				worktreePath: null,
				worktreeBranch: "tmp-resume",
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
			return workflow as Workflow;
		},
		transition: (_id: string, status: WorkflowStatus) => {
			if (workflow) workflow.status = status;
		},
		updateLastOutput: () => {},
		setQuestion: () => {},
		clearQuestion: () => {},
		updateSummary: () => {},
		updateStepSummary: () => {},
		createWorktree: async () => "/tmp/resume-itest-worktree",
		copyGitignoredFiles: async () => {},
		removeWorktree: async () => {},
		moveWorktree: async () => "/tmp/resume-itest-worktree",
	};
}

describe("Plain Resume regression — User Story 2", () => {
	let baseDir: string;
	let auditDir: string;
	let store: WorkflowStore;
	let auditLogger: AuditLogger;

	beforeEach(() => {
		baseDir = join(
			tmpdir(),
			`workflow-resume-regression-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

	test("plain resume on a paused step with sessionId emits no feedback entry, no resume-with-feedback audit event, and no injected prompt (SC-002)", async () => {
		const callbacks: PipelineCallbacks = {
			onStepChange: () => {},
			onOutput: () => {},
			onTools: (_id: string, _tools: ToolUsage[]) => {},
			onComplete: () => {},
			onError: () => {},
			onStateChange: () => {},
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

		const wf = await engine.createWorkflow("plain resume spec", "/tmp/resume-repo");
		wf.worktreePath = "/tmp/resume-itest-worktree";
		const stepIdx = wf.steps.findIndex((s) => s.name === STEP.IMPLEMENT);
		for (let i = 0; i < stepIdx; i++) wf.steps[i].status = "completed";
		wf.currentStepIndex = stepIdx;
		wf.steps[stepIdx].status = "paused";
		wf.steps[stepIdx].sessionId = "sess-plain-resume";
		wf.status = "paused";
		await store.save(wf);

		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).currentAuditRunId = auditLogger.startRun("plain-resume", wf.worktreeBranch);
		// biome-ignore lint/suspicious/noExplicitAny: test-only access
		(orch as any).pipelineName = "plain-resume";

		orch.resume(wf.id);
		await new Promise((r) => setTimeout(r, 10));

		// SC-002: plain resume does NOT inject `Also consider this:` text
		expect(cli.resumeCalls).toHaveLength(1);
		const promptArg = cli.resumeCalls[0].prompt ?? "";
		expect(promptArg).not.toContain("Also consider this:");

		// No FeedbackEntry was appended
		expect(wf.feedbackEntries).toHaveLength(0);

		// No feedback_submitted_resume audit line
		const auditFile = readdirSync(auditDir).find((f) => f.includes("plain-resume"));
		expect(auditFile).toBeDefined();
		if (!auditFile) return;
		const events = readFileSync(join(auditDir, auditFile), "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		expect(events.some((e) => e.eventType === "feedback_submitted_resume")).toBe(false);
	});
});
