import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CLICallbacks, CLIRunner } from "../../src/cli-runner";
import { configStore, DEFAULT_CONFIG } from "../../src/config-store";
import type { PipelineCallbacks } from "../../src/pipeline-orchestrator";
import { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type { EffortLevel, PipelineStepStatus, Workflow, WorkflowStatus } from "../../src/types";
import { getStepDefinitionsForKind, STEP } from "../../src/types";
import { getArtifactsRoot, listArtifacts } from "../../src/workflow-artifacts";
import type { WorkflowEngine } from "../../src/workflow-engine";
import { WorkflowStore } from "../../src/workflow-store";

const cleanupDirs: string[] = [];

beforeEach(() => {
	// Ensure each test starts from built-in defaults, even if a prior test in
	// the same process polluted the config store.
	configStore.reset();
});

afterEach(() => {
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	}
});

function registerCleanup(dir: string): void {
	cleanupDirs.push(dir);
}

function makeSpecWorkflow(id: string, worktreePath: string, branch: string): Workflow {
	const steps = getStepDefinitionsForKind("spec").map((def) => ({
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
		id,
		workflowKind: "spec",
		specification: "demo",
		status: "running",
		targetRepository: "/tmp/repo",
		worktreePath,
		worktreeBranch: branch,
		featureBranch: branch,
		error: null,
		summary: "",
		stepSummary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps,
		currentStepIndex: steps.findIndex((s) => s.name === STEP.ARTIFACTS),
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
		hasEverStarted: false,
		createdAt: now,
		updatedAt: now,
	};
}

interface StubCli {
	runner: CLIRunner;
	startCalls: Array<{ workflow: Workflow; callbacks: CLICallbacks }>;
	lastStarted: () => { workflow: Workflow; callbacks: CLICallbacks } | undefined;
}

function makeStubCli(): StubCli {
	const startCalls: Array<{ workflow: Workflow; callbacks: CLICallbacks }> = [];
	const runner = {
		start(
			workflow: Workflow,
			callbacks: CLICallbacks,
			_extraEnv?: Record<string, string>,
			_model?: string,
			_effort?: EffortLevel,
		) {
			startCalls.push({ workflow, callbacks });
		},
		resume() {},
		kill() {
			const last = startCalls[startCalls.length - 1];
			last?.callbacks.onError("process killed");
		},
		killAll() {},
	} as unknown as CLIRunner;
	return {
		runner,
		startCalls,
		lastStarted: () => startCalls[startCalls.length - 1],
	};
}

function makeStubEngine(wf: Workflow) {
	return {
		getWorkflow: () => wf,
		setWorkflow: () => {},
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
	} as unknown as WorkflowEngine;
}

describe("US1: artifacts step runs and collects files for spec workflows", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		baseDir = join(tmpdir(), `artifacts-t010-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(baseDir, { recursive: true });
		store = new WorkflowStore(baseDir);
		registerCleanup(baseDir);
	});

	test("LLM writes manifest + files → step completes with outcome=with-files and files appear in listArtifacts", async () => {
		const id = `wf-a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const worktreePath = join(baseDir, "worktree");
		mkdirSync(worktreePath, { recursive: true });
		const branch = "feat-artifacts";

		const wf = makeSpecWorkflow(id, worktreePath, branch);
		registerCleanup(getArtifactsRoot(id));

		const cli = makeStubCli();
		const engine = makeStubEngine(wf);
		const callbacks: PipelineCallbacks = {
			onStepChange: () => {},
			onOutput: () => {},
			onTools: () => {},
			onComplete: () => {},
			onError: () => {},
			onStateChange: () => {},
		};

		const orch = new PipelineOrchestrator(callbacks, {
			engine,
			cliRunner: cli.runner,
			workflowStore: store,
		});

		orch.startPipelineFromWorkflow(wf);
		await new Promise((r) => setTimeout(r, 10));

		// The artifacts step should have been dispatched via the stub CLI.
		expect(cli.startCalls.length).toBe(1);
		const invocation = cli.lastStarted();
		expect(invocation).toBeDefined();

		// The orchestrator always injects its own prompt for the artifacts step
		// (the static prompt in PIPELINE_STEP_DEFINITIONS is empty). Confirm
		// the built prompt references the output directory so the LLM knows
		// where to write files.
		const outputDir = join(worktreePath, "specs", branch, "artifacts-output");
		expect(invocation?.workflow.specification).toContain(outputDir);

		// Simulate the LLM writing two artifacts + a manifest into the output dir.
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(outputDir, "test-report.md"), "# All green\n");
		writeFileSync(join(outputDir, "coverage.json"), JSON.stringify({ lines: 0.95 }));
		writeFileSync(
			join(outputDir, "manifest.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{ path: "test-report.md", description: "Playwright + bun test summary" },
					{ path: "coverage.json", description: "Line coverage" },
				],
			}),
		);

		// Drive CLI completion.
		invocation?.callbacks.onOutput("Summary of what was generated");
		invocation?.callbacks.onComplete();
		await new Promise((r) => setTimeout(r, 30));

		const step = wf.steps.find((s) => s.name === STEP.ARTIFACTS);
		expect(step?.status).toBe("completed");
		expect(step?.outcome).toBe("with-files");

		const items = listArtifacts(wf).items.filter((i) => i.step === "artifacts");
		expect(items.map((i) => i.relPath).sort()).toEqual(["coverage.json", "test-report.md"]);
		expect(items.find((i) => i.relPath === "test-report.md")?.description).toBe(
			"Playwright + bun test summary",
		);
	});

	test("US3: files survive worktree + branch deletion and simulated restart", async () => {
		const id = `wf-d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const worktreePath = join(baseDir, "worktree-durable");
		mkdirSync(worktreePath, { recursive: true });
		const branch = "feat-durable";

		const wf = makeSpecWorkflow(id, worktreePath, branch);
		registerCleanup(getArtifactsRoot(id));

		const cli = makeStubCli();
		const engine = makeStubEngine(wf);
		const orch = new PipelineOrchestrator(
			{
				onStepChange: () => {},
				onOutput: () => {},
				onTools: () => {},
				onComplete: () => {},
				onError: () => {},
				onStateChange: () => {},
			},
			{ engine, cliRunner: cli.runner, workflowStore: store },
		);

		orch.startPipelineFromWorkflow(wf);
		await new Promise((r) => setTimeout(r, 10));

		const outputDir = join(worktreePath, "specs", branch, "artifacts-output");
		mkdirSync(outputDir, { recursive: true });
		const originalBytes = "Durable content — should survive worktree removal.";
		writeFileSync(join(outputDir, "report.md"), originalBytes);
		writeFileSync(
			join(outputDir, "manifest.json"),
			JSON.stringify({
				version: 1,
				artifacts: [{ path: "report.md", description: "Run report" }],
			}),
		);

		cli.lastStarted()?.callbacks.onComplete();
		await new Promise((r) => setTimeout(r, 50));

		// Wipe the worktree entirely and invalidate the branch association, then
		// build a fresh Workflow object to mimic "server restart with only the
		// persistent store available". Windows occasionally holds a transient
		// lock from the async persist; tolerate that failure — the test's point
		// is that listArtifacts still returns the file, which exercises the
		// persistent-store path regardless of whether the worktree is gone.
		try {
			rmSync(worktreePath, { recursive: true, force: true });
		} catch {
			// Leave the worktree in place on EBUSY — the afterRestart workflow
			// still has worktreePath: null below so listArtifacts ignores it.
		}
		const afterRestart = { ...wf, worktreePath: null, featureBranch: null };
		const items = listArtifacts(afterRestart).items.filter((i) => i.step === "artifacts");
		expect(items.length).toBe(1);
		expect(items[0].relPath).toBe("report.md");

		// Bytes must be identical.
		const { readFileSync } = await import("node:fs");
		const snapshotPath = join(getArtifactsRoot(id), "artifacts", "_", "report.md");
		expect(readFileSync(snapshotPath, "utf-8")).toBe(originalBytes);
	});

	test("US4: config changes applied between runs take effect on the next run (no restart)", async () => {
		// Save a custom model + effort + caps + timeout via the store, then run
		// a fresh artifacts step and assert the CLI was invoked with the new
		// model/effort and the new per-file cap is enforced.
		const saveResult = configStore.save({
			models: { artifacts: "claude-custom-artifacts" },
			efforts: { artifacts: "high" },
			limits: {
				artifactsPerFileMaxBytes: 1_048_576,
				artifactsPerStepMaxBytes: 4_194_304,
			},
			timing: { artifactsTimeoutMs: 5 * 60_000 },
		});
		expect(saveResult.errors).toEqual([]);

		const id = `wf-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const worktreePath = join(baseDir, "worktree-cfg");
		mkdirSync(worktreePath, { recursive: true });
		const branch = "feat-cfg";

		const wf = makeSpecWorkflow(id, worktreePath, branch);
		registerCleanup(getArtifactsRoot(id));

		const startCalls: Array<{
			workflow: Workflow;
			callbacks: CLICallbacks;
			model?: string;
			effort?: EffortLevel;
		}> = [];
		const runner = {
			start(
				workflow: Workflow,
				callbacks: CLICallbacks,
				_extraEnv?: Record<string, string>,
				model?: string,
				effort?: EffortLevel,
			) {
				startCalls.push({ workflow, callbacks, model, effort });
			},
			resume() {},
			kill() {},
			killAll() {},
		} as unknown as CLIRunner;

		const engine = makeStubEngine(wf);
		const orch = new PipelineOrchestrator(
			{
				onStepChange: () => {},
				onOutput: () => {},
				onTools: () => {},
				onComplete: () => {},
				onError: () => {},
				onStateChange: () => {},
			},
			{ engine, cliRunner: runner, workflowStore: store },
		);

		orch.startPipelineFromWorkflow(wf);
		await new Promise((r) => setTimeout(r, 10));

		expect(startCalls.length).toBe(1);
		expect(startCalls[0].model).toBe("claude-custom-artifacts");
		expect(startCalls[0].effort).toBe("high");

		// Emit a manifest that declares one oversized file. With the new 1 MB
		// per-file cap it must be rejected (soft), leaving outcome=empty.
		const outputDir = join(worktreePath, "specs", branch, "artifacts-output");
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(outputDir, "huge.md"), "x".repeat(1_048_577));
		writeFileSync(
			join(outputDir, "manifest.json"),
			JSON.stringify({
				version: 1,
				artifacts: [{ path: "huge.md", description: "oversize" }],
			}),
		);

		startCalls[0].callbacks.onComplete();
		await new Promise((r) => setTimeout(r, 30));

		const step = wf.steps.find((s) => s.name === STEP.ARTIFACTS);
		expect(step?.status).toBe("completed");
		expect(step?.outcome).toBe("empty");
	});

	test("US5: LLM exits non-zero → step goes to error with the CLI message; earlier-step artifacts untouched", async () => {
		const id = `wf-llm-err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const worktreePath = join(baseDir, "worktree-err");
		mkdirSync(worktreePath, { recursive: true });
		const branch = "feat-err";

		const wf = makeSpecWorkflow(id, worktreePath, branch);
		registerCleanup(getArtifactsRoot(id));

		// Seed a prior-step snapshot so we can later assert it survived untouched.
		const priorSnap = join(getArtifactsRoot(id), "specify", "_", "spec.md");
		mkdirSync(join(priorSnap, ".."), { recursive: true });
		writeFileSync(priorSnap, "# prior content");

		const cli = makeStubCli();
		const engine = makeStubEngine(wf);
		const orch = new PipelineOrchestrator(
			{
				onStepChange: () => {},
				onOutput: () => {},
				onTools: () => {},
				onComplete: () => {},
				onError: () => {},
				onStateChange: () => {},
			},
			{ engine, cliRunner: cli.runner, workflowStore: store },
		);

		orch.startPipelineFromWorkflow(wf);
		await new Promise((r) => setTimeout(r, 10));
		cli.lastStarted()?.callbacks.onError("Claude exited with status 1: rate-limited");
		await new Promise((r) => setTimeout(r, 30));

		const step = wf.steps.find((s) => s.name === STEP.ARTIFACTS);
		expect(step?.status).toBe("error");
		expect(step?.error).toContain("rate-limited");

		// Earlier-step snapshot is intact (FR-012 guarantee).
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(priorSnap, "utf-8")).toBe("# prior content");
	});

	test("US5: missing manifest.json → error with the manifest-missing reason", async () => {
		const id = `wf-no-man-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const worktreePath = join(baseDir, "worktree-no-man");
		mkdirSync(worktreePath, { recursive: true });
		const branch = "feat-no-man";

		const wf = makeSpecWorkflow(id, worktreePath, branch);
		registerCleanup(getArtifactsRoot(id));

		const cli = makeStubCli();
		const engine = makeStubEngine(wf);
		const orch = new PipelineOrchestrator(
			{
				onStepChange: () => {},
				onOutput: () => {},
				onTools: () => {},
				onComplete: () => {},
				onError: () => {},
				onStateChange: () => {},
			},
			{ engine, cliRunner: cli.runner, workflowStore: store },
		);

		orch.startPipelineFromWorkflow(wf);
		await new Promise((r) => setTimeout(r, 10));

		// LLM exits cleanly but never wrote a manifest.json into the output dir.
		cli.lastStarted()?.callbacks.onOutput("I finished, but forgot the manifest.");
		cli.lastStarted()?.callbacks.onComplete();
		await new Promise((r) => setTimeout(r, 30));

		const step = wf.steps.find((s) => s.name === STEP.ARTIFACTS);
		expect(step?.status).toBe("error");
		expect(step?.error).toContain("No manifest.json");
	});

	test("LLM emits empty manifest → outcome=empty and no files listed", async () => {
		const id = `wf-e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const worktreePath = join(baseDir, "worktree-empty");
		mkdirSync(worktreePath, { recursive: true });
		const branch = "feat-empty";

		const wf = makeSpecWorkflow(id, worktreePath, branch);
		registerCleanup(getArtifactsRoot(id));

		const cli = makeStubCli();
		const engine = makeStubEngine(wf);
		const orch = new PipelineOrchestrator(
			{
				onStepChange: () => {},
				onOutput: () => {},
				onTools: () => {},
				onComplete: () => {},
				onError: () => {},
				onStateChange: () => {},
			},
			{ engine, cliRunner: cli.runner, workflowStore: store },
		);

		orch.startPipelineFromWorkflow(wf);
		await new Promise((r) => setTimeout(r, 10));

		const outputDir = join(worktreePath, "specs", branch, "artifacts-output");
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(outputDir, "manifest.json"), JSON.stringify({ version: 1, artifacts: [] }));

		cli.lastStarted()?.callbacks.onComplete();
		await new Promise((r) => setTimeout(r, 30));

		const step = wf.steps.find((s) => s.name === STEP.ARTIFACTS);
		expect(step?.status).toBe("completed");
		expect(step?.outcome).toBe("empty");
		expect(listArtifacts(wf).items.some((i) => i.step === "artifacts")).toBe(false);
	});

	test("salvage: CLI error AFTER a valid manifest was written → step completes with those files", async () => {
		const id = `wf-salvage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const worktreePath = join(baseDir, "worktree-salvage");
		mkdirSync(worktreePath, { recursive: true });
		const branch = "feat-salvage";

		const wf = makeSpecWorkflow(id, worktreePath, branch);
		registerCleanup(getArtifactsRoot(id));

		const cli = makeStubCli();
		const engine = makeStubEngine(wf);
		const orch = new PipelineOrchestrator(
			{
				onStepChange: () => {},
				onOutput: () => {},
				onTools: () => {},
				onComplete: () => {},
				onError: () => {},
				onStateChange: () => {},
			},
			{ engine, cliRunner: cli.runner, workflowStore: store },
		);

		orch.startPipelineFromWorkflow(wf);
		await new Promise((r) => setTimeout(r, 10));

		// Agent finished its real work (manifest + files on disk) but the CLI
		// then hung and the idle timer killed it — reproducing the 001
		// merge-conflict-e2e report.
		const outputDir = join(worktreePath, "specs", branch, "artifacts-output");
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(outputDir, "summary.md"), "# Summary");
		writeFileSync(
			join(outputDir, "manifest.json"),
			JSON.stringify({
				version: 1,
				artifacts: [{ path: "summary.md", description: "Reviewer overview" }],
			}),
		);

		cli
			.lastStarted()
			?.callbacks.onError("CLI process killed — no output received within idle timeout");
		await new Promise((r) => setTimeout(r, 30));

		const step = wf.steps.find((s) => s.name === STEP.ARTIFACTS);
		expect(step?.status).toBe("completed");
		expect(step?.outcome).toBe("with-files");
		expect(step?.error).toBeNull();

		const items = listArtifacts(wf).items.filter((i) => i.step === "artifacts");
		expect(items.map((i) => i.relPath)).toEqual(["summary.md"]);
	});

	test("salvage: wall-clock timeout AFTER a valid manifest was written → step completes", async () => {
		const id = `wf-salvage-to-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const worktreePath = join(baseDir, "worktree-salvage-to");
		mkdirSync(worktreePath, { recursive: true });
		const branch = "feat-salvage-to";

		const wf = makeSpecWorkflow(id, worktreePath, branch);
		registerCleanup(getArtifactsRoot(id));

		const cli = makeStubCli();
		const engine = makeStubEngine(wf);
		const orch = new PipelineOrchestrator(
			{
				onStepChange: () => {},
				onOutput: () => {},
				onTools: () => {},
				onComplete: () => {},
				onError: () => {},
				onStateChange: () => {},
			},
			{ engine, cliRunner: cli.runner, workflowStore: store },
		);

		orch.startPipelineFromWorkflow(wf);
		await new Promise((r) => setTimeout(r, 10));

		const outputDir = join(worktreePath, "specs", branch, "artifacts-output");
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(outputDir, "report.md"), "# Report");
		writeFileSync(
			join(outputDir, "manifest.json"),
			JSON.stringify({
				version: 1,
				artifacts: [{ path: "report.md", description: "Run report" }],
			}),
		);

		// Flip the wall-clock flag the orchestrator's timer would set, then
		// deliver the CLI kill it would have dispatched.
		// biome-ignore lint/suspicious/noExplicitAny: access to private state for focused test
		const artifactsState = (orch as any).artifactsState.get(id);
		expect(artifactsState).toBeDefined();
		artifactsState.timedOut = true;
		cli.lastStarted()?.callbacks.onError("process killed");
		await new Promise((r) => setTimeout(r, 30));

		const step = wf.steps.find((s) => s.name === STEP.ARTIFACTS);
		expect(step?.status).toBe("completed");
		expect(step?.outcome).toBe("with-files");
	});

	test("US5: wall-clock timeout kills the CLI and surfaces a timeout: error (FR-016)", async () => {
		const id = `wf-timeout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const worktreePath = join(baseDir, "worktree-timeout");
		mkdirSync(worktreePath, { recursive: true });
		const branch = "feat-timeout";

		const wf = makeSpecWorkflow(id, worktreePath, branch);
		registerCleanup(getArtifactsRoot(id));

		const cli = makeStubCli();
		const engine = makeStubEngine(wf);
		const orch = new PipelineOrchestrator(
			{
				onStepChange: () => {},
				onOutput: () => {},
				onTools: () => {},
				onComplete: () => {},
				onError: () => {},
				onStateChange: () => {},
			},
			{ engine, cliRunner: cli.runner, workflowStore: store },
		);

		orch.startPipelineFromWorkflow(wf);
		await new Promise((r) => setTimeout(r, 10));

		// The min timeout enforced by configStore (60s) is too long to wait for
		// the real setTimeout to fire in-test. Simulate the timer callback by
		// flipping the state's `timedOut` flag, then dispatch the CLI kill the
		// timer would normally produce. handleStepError recognises the flag and
		// produces the wall-clock-timeout reason.
		// biome-ignore lint/suspicious/noExplicitAny: access to private state for focused test
		const artifactsState = (orch as any).artifactsState.get(id);
		expect(artifactsState).toBeDefined();
		artifactsState.timedOut = true;
		cli.lastStarted()?.callbacks.onError("process killed");
		await new Promise((r) => setTimeout(r, 30));

		const step = wf.steps.find((s) => s.name === STEP.ARTIFACTS);
		expect(step?.status).toBe("error");
		expect(step?.error ?? "").toContain("exceeded wall-clock timeout");
	});
});
