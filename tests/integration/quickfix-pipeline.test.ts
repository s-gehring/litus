import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CLICallbacks } from "../../src/cli-runner";
import { configStore, DEFAULT_CONFIG } from "../../src/config-store";
import type { PipelineCallbacks } from "../../src/pipeline-orchestrator";
import { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import { routeAfterStep } from "../../src/step-router";
import type { EffortLevel, PipelineStepStatus, Workflow, WorkflowStatus } from "../../src/types";
import { getStepDefinitionsForKind, STEP, shouldPauseBeforeMerge } from "../../src/types";
import { WorkflowEngine } from "../../src/workflow-engine";
import { WorkflowStore } from "../../src/workflow-store";

// ── Structural contract tests ─────────────────────────────────────────────

describe("quick-fix pipeline structure", () => {
	test("step ordering matches the contract (setup → fix-implement → shared downstream)", async () => {
		const engine = new WorkflowEngine();
		const wf = await engine.createWorkflow("fix it", "/tmp/repo", null, {
			workflowKind: "quick-fix",
		});
		const names = wf.steps.map((s) => s.name);
		expect(names).toEqual([
			STEP.SETUP,
			STEP.FIX_IMPLEMENT,
			STEP.COMMIT_PUSH_PR,
			STEP.MONITOR_CI,
			STEP.FIX_CI,
			STEP.FEEDBACK_IMPLEMENTER,
			STEP.MERGE_PR,
			STEP.SYNC_REPO,
		]);
	});

	test("quick-fix step list does not include any speckit steps", () => {
		const defs = getStepDefinitionsForKind("quick-fix");
		const names = defs.map((d) => d.name);
		for (const forbidden of [
			STEP.SPECIFY,
			STEP.CLARIFY,
			STEP.PLAN,
			STEP.TASKS,
			STEP.IMPLEMENT,
			STEP.REVIEW,
			STEP.IMPLEMENT_REVIEW,
		]) {
			expect(names).not.toContain(forbidden);
		}
	});

	test("downstream step dispatch (commit-push-pr through sync-repo) is shared with spec workflows", () => {
		const specDefs = getStepDefinitionsForKind("spec");
		const fixDefs = getStepDefinitionsForKind("quick-fix");
		for (const shared of [
			STEP.COMMIT_PUSH_PR,
			STEP.MONITOR_CI,
			STEP.FIX_CI,
			STEP.FEEDBACK_IMPLEMENTER,
			STEP.MERGE_PR,
			STEP.SYNC_REPO,
		]) {
			const specDef = specDefs.find((d) => d.name === shared);
			const fixDef = fixDefs.find((d) => d.name === shared);
			expect(specDef).toBeDefined();
			expect(fixDef).toBeDefined();
			// Identity check — both kinds must reference the SAME definition object
			// so there can be no forked downstream handlers (SC-003).
			expect(fixDef).toBe(specDef);
		}
	});
});

// ── T020: automatic-mode drive asserts shared routing (behavioral, not source-regex) ─

describe("T020: quick-fix downstream routing parity in automatic mode", () => {
	function makeWorkflow(): Workflow {
		const steps = getStepDefinitionsForKind("quick-fix").map((def) => ({
			name: def.name,
			displayName: def.displayName,
			status: "pending" as PipelineStepStatus,
			prompt: def.prompt,
			sessionId: null,
			output: "",
			outputLog: [],
			error: null,
			startedAt: null,
			completedAt: null as string | null,
			pid: null,
			history: [],
		}));
		const now = new Date().toISOString();
		return {
			id: "qf-route",
			workflowKind: "quick-fix",
			specification: "fix thing",
			status: "running",
			targetRepository: "/tmp/repo",
			worktreePath: "/tmp/wt",
			worktreeBranch: "fix/001-thing",
			featureBranch: "fix/001-thing",
			summary: "",
			stepSummary: "",
			flavor: "",
			pendingQuestion: null,
			lastOutput: "",
			steps,
			currentStepIndex: 0,
			reviewCycle: { iteration: 1, maxIterations: 16, lastSeverity: null },
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
			createdAt: now,
			updatedAt: now,
		};
	}

	test("post-fix-implement routing advances to commit-push-pr (no duplicated handler)", () => {
		const wf = makeWorkflow();
		const fixIdx = wf.steps.findIndex((s) => s.name === STEP.FIX_IMPLEMENT);
		wf.currentStepIndex = fixIdx;
		// fix-implement has no dedicated branch in routeAfterStep → default advance
		expect(routeAfterStep(wf)).toEqual({ action: "advance-to-next" });
		// Next step in the list is commit-push-pr — identical to spec flow
		expect(wf.steps[fixIdx + 1].name).toBe(STEP.COMMIT_PUSH_PR);
	});

	test("commit-push-pr → monitor-ci → merge-pr → sync-repo → complete (shared with spec)", () => {
		const wf = makeWorkflow();
		const steps: Array<
			| typeof STEP.COMMIT_PUSH_PR
			| typeof STEP.MONITOR_CI
			| typeof STEP.MERGE_PR
			| typeof STEP.SYNC_REPO
		> = [STEP.COMMIT_PUSH_PR, STEP.MONITOR_CI, STEP.MERGE_PR, STEP.SYNC_REPO];
		const expected = ["route-to-monitor-ci", "route-to-merge-pr", "route-to-sync-repo", "complete"];
		for (let i = 0; i < steps.length; i++) {
			wf.currentStepIndex = wf.steps.findIndex((s) => s.name === steps[i]);
			expect(routeAfterStep(wf).action).toBe(expected[i] as never);
		}
	});
});

// ── T021: manual-mode feedback-implementer gate parity ───────────────────

describe("T021: quick-fix manual-mode merge-pr gate drives through feedback-implementer", () => {
	test("shouldPauseBeforeMerge gates on autoMode only (no workflowKind coupling)", () => {
		// Pure function — if this ever grows a workflowKind parameter, the gate
		// is no longer shared and T023's decoupling has been broken.
		expect(shouldPauseBeforeMerge.length).toBe(1);
		expect(shouldPauseBeforeMerge("manual")).toBe(true);
		expect(shouldPauseBeforeMerge("normal")).toBe(false);
		expect(shouldPauseBeforeMerge("full-auto")).toBe(false);
	});

	test("quick-fix step list positions feedback-implementer between fix-ci and merge-pr", () => {
		const defs = getStepDefinitionsForKind("quick-fix").map((d) => d.name);
		const fixCiIdx = defs.indexOf(STEP.FIX_CI);
		const fiIdx = defs.indexOf(STEP.FEEDBACK_IMPLEMENTER);
		const mergeIdx = defs.indexOf(STEP.MERGE_PR);
		// FR-011 parity: FI sits between the CI cycle and merge-pr for both kinds
		expect(fixCiIdx).toBeGreaterThan(-1);
		expect(fiIdx).toBe(fixCiIdx + 1);
		expect(mergeIdx).toBe(fiIdx + 1);
	});
});

// ── T015: fix-implement empty-diff → error (orchestrator-level) ──────────

describe("T015: fix-implement empty-diff routes to error and blocks advance", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		baseDir = join(tmpdir(), `quickfix-t015-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(baseDir, { recursive: true });
		store = new WorkflowStore(baseDir);
		configStore.save({ autoMode: "normal" });
	});

	afterEach(() => {
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {}
	});

	function makeFakeCli() {
		const startCalls: Array<{ workflow: Workflow; callbacks: CLICallbacks }> = [];
		return {
			start(
				workflow: Workflow,
				callbacks: CLICallbacks,
				_extraEnv?: Record<string, string>,
				_model?: string,
				_effort?: EffortLevel,
			) {
				startCalls.push({ workflow, callbacks });
				callbacks.onOutput("[stub] fix-implement CLI invoked");
			},
			resume() {},
			kill() {},
			killAll() {},
			startCalls,
		};
	}

	function makeFakeEngine(wf: Workflow) {
		return {
			getWorkflow: () => wf,
			setWorkflow: (_: Workflow) => {},
			createWorkflow: async () => wf,
			transition: (_id: string, status: WorkflowStatus) => {
				wf.status = status;
			},
			updateLastOutput: () => {},
			setQuestion: () => {},
			clearQuestion: () => {},
			updateSummary: () => {},
			updateStepSummary: () => {},
			createWorktree: async () => wf.worktreePath ?? "/tmp/wt",
			copyGitignoredFiles: async () => {},
			removeWorktree: async () => {},
			moveWorktree: async () => wf.worktreePath ?? "/tmp/wt",
		};
	}

	function seedFixImplement(): Workflow {
		const steps = getStepDefinitionsForKind("quick-fix").map((def) => ({
			name: def.name,
			displayName: def.displayName,
			status: "pending" as PipelineStepStatus,
			prompt: def.prompt,
			sessionId: null,
			output: "",
			outputLog: [],
			error: null,
			startedAt: null,
			completedAt: null as string | null,
			pid: null,
			history: [],
		}));
		const now = new Date().toISOString();
		const wf: Workflow = {
			id: "qf-t015",
			workflowKind: "quick-fix",
			specification: "no-op fix",
			status: "running",
			targetRepository: "/tmp/repo",
			worktreePath: "/tmp/wt",
			worktreeBranch: "fix/001-no-op",
			featureBranch: "fix/001-no-op",
			summary: "",
			stepSummary: "",
			flavor: "",
			pendingQuestion: null,
			lastOutput: "",
			steps,
			currentStepIndex: steps.findIndex((s) => s.name === STEP.FIX_IMPLEMENT),
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
			createdAt: now,
			updatedAt: now,
		};
		steps[0].status = "completed";
		return wf;
	}

	test("when pre-run and post-run HEAD match, step resolves to error and currentStepIndex does not advance", async () => {
		const wf = seedFixImplement();
		const originalIdx = wf.currentStepIndex;

		const callbacks: PipelineCallbacks = {
			onStepChange: () => {},
			onOutput: () => {},
			onTools: () => {},
			onComplete: () => {},
			onError: () => {},
			onStateChange: () => {},
		};

		const cli = makeFakeCli();
		const engine = makeFakeEngine(wf);
		const orch = new PipelineOrchestrator(callbacks, {
			engine: engine as unknown as WorkflowEngine,
			cliRunner: cli as unknown as import("../../src/cli-runner").CLIRunner,
			workflowStore: store,
			getGitHead: async () => "same-sha",
			detectNewCommits: async () => [],
		});

		// Drive: startStep runs fix-implement → runFixImplement → CLI (fake) →
		// simulate CLI success → handleStepComplete → completeFixImplement
		// detects empty diff and routes to error.
		orch.startPipelineFromWorkflow(wf);
		await new Promise((r) => setTimeout(r, 10));

		// Mark step as running then simulate CLI completion with non-empty output
		// so completeFixImplement runs.
		const step = wf.steps[originalIdx];
		step.status = "running";
		step.output = "[stub] fix-implement CLI invoked";
		cli.startCalls[0]?.callbacks.onOutput("done");
		cli.startCalls[0]?.callbacks.onComplete();
		await new Promise((r) => setTimeout(r, 30));

		expect(wf.status).toBe("error");
		expect(wf.steps[originalIdx].name).toBe(STEP.FIX_IMPLEMENT);
		expect(wf.steps[originalIdx].error).toBe("no changes produced");
		expect(wf.currentStepIndex).toBe(originalIdx);
	});
});
