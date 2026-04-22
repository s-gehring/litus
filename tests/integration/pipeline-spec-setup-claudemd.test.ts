import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_CLAUDEMD_SEPARATOR } from "../../src/claude-md-merger";
import type { CLICallbacks } from "../../src/cli-runner";
import type { PipelineCallbacks } from "../../src/pipeline-orchestrator";
import { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type { Workflow, WorkflowKind, WorkflowStatus } from "../../src/types";
import { getStepDefinitionsForKind } from "../../src/types";
import { WorkflowStore } from "../../src/workflow-store";

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "t@e.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "t@e.com",
};

async function run(cmd: string[], cwd: string): Promise<number> {
	const p = Bun.spawn(cmd, { cwd, env: GIT_ENV, stdout: "ignore", stderr: "ignore" });
	return await p.exited;
}

interface RepoFixture {
	main: string;
	spec: string;
	cleanup: () => Promise<void>;
}

async function makeRepo(projectClaudeMd: string | null): Promise<RepoFixture> {
	const main = mkdtempSync(join(tmpdir(), "crab-pipe-main-"));
	const wtRoot = mkdtempSync(join(tmpdir(), "crab-pipe-wt-"));
	const spec = join(wtRoot, "spec");
	// Windows rmSync can race with in-flight git child processes and hit EBUSY.
	// Retry briefly to give those processes time to release the directory.
	const rmWithRetry = async (path: string) => {
		for (let i = 0; i < 20; i++) {
			try {
				rmSync(path, { recursive: true, force: true });
				return;
			} catch {
				await new Promise((r) => setTimeout(r, 50));
			}
		}
		rmSync(path, { recursive: true, force: true });
	};
	const cleanup = async () => {
		await rmWithRetry(main);
		await rmWithRetry(wtRoot);
	};
	try {
		if ((await run(["git", "init", "-b", "main"], main)) !== 0) throw new Error("git init");
		writeFileSync(join(main, "seed.txt"), "seed");
		if ((await run(["git", "add", "."], main)) !== 0) throw new Error("git add");
		if ((await run(["git", "commit", "-m", "init"], main)) !== 0) throw new Error("git commit");
		if (projectClaudeMd !== null) writeFileSync(join(main, "CLAUDE.md"), projectClaudeMd);
		if ((await run(["git", "worktree", "add", "--detach", spec], main)) !== 0)
			throw new Error("git worktree add");
		return { main, spec, cleanup };
	} catch (err) {
		cleanup();
		throw err;
	}
}

function makeFakeEngine(workflow: Workflow) {
	return {
		getWorkflow: () => workflow,
		createWorkflow: async () => workflow,
		transition: (_id: string, status: WorkflowStatus) => {
			workflow.status = status;
		},
		updateLastOutput: () => {},
		setQuestion: () => {},
		clearQuestion: () => {},
		updateSummary: () => {},
		updateStepSummary: () => {},
		createWorktree: async () => workflow.worktreePath ?? "",
		copyGitignoredFiles: async () => {},
		removeWorktree: async () => {},
		moveWorktree: async () => workflow.worktreePath ?? "",
	};
}

function makeFakeCli() {
	return {
		start: () => {},
		resume: (
			_id: string,
			_s: string,
			_cwd: string,
			_cb: CLICallbacks,
			_env?: Record<string, string>,
			_p?: string,
		) => {},
		kill: () => {},
		killAll: () => {},
	};
}

function makeWorkflow(kind: WorkflowKind, worktreePath: string): Workflow {
	const now = new Date().toISOString();
	return {
		id: "itest-claudemd",
		workflowKind: kind,
		specification: "spec",
		status: "running",
		targetRepository: "/tmp/noop",
		worktreePath,
		worktreeBranch: "tmp-test",
		featureBranch: null,
		summary: "",
		stepSummary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: getStepDefinitionsForKind(kind).map((def) => ({
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
		reviewCycle: { iteration: 1, maxIterations: 3, lastSeverity: null },
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
		createdAt: now,
		updatedAt: now,
		archived: false,
		archivedAt: null,
	};
}

describe("pipeline spec-setup CLAUDE.md append — integration", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "crab-pipe-store-"));
		store = new WorkflowStore(baseDir);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	function makeOrch(workflow: Workflow) {
		const outputs: Array<{ workflowId: string; text: string }> = [];
		const errors: Array<{ workflowId: string; text: string }> = [];
		const cb: PipelineCallbacks = {
			onStepChange: () => {},
			onOutput: (workflowId, text) => outputs.push({ workflowId, text }),
			onTools: () => {},
			onComplete: () => {},
			onError: (workflowId, text) => errors.push({ workflowId, text }),
			onStateChange: () => {},
		};
		const orch = new PipelineOrchestrator(cb, {
			engine: makeFakeEngine(
				workflow,
			) as unknown as import("../../src/workflow-engine").WorkflowEngine,
			cliRunner: makeFakeCli() as unknown as import("../../src/cli-runner").CLIRunner,
			workflowStore: store,
			ensureSpeckitSkills: async () => ({ installed: true, initResult: null }),
		});
		return { orch, outputs, errors };
	}

	async function until(
		predicate: () => boolean,
		opts: { timeoutMs?: number; intervalMs?: number } = {},
	): Promise<void> {
		const timeoutMs = opts.timeoutMs ?? 5000;
		const intervalMs = opts.intervalMs ?? 10;
		const start = Date.now();
		while (!predicate()) {
			if (Date.now() - start > timeoutMs) {
				throw new Error(`until: predicate did not hold within ${timeoutMs}ms`);
			}
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}

	test("US1+US2: spec workflow appends project CLAUDE.md to generated, preserving prefix", async () => {
		const projectBytes = "# Project Guidelines\n\nAlways be kind.";
		const fx = await makeRepo(projectBytes);
		try {
			const generatedPrefix = "# Speckit Generated\n\nFollow the rituals.\n";
			writeFileSync(join(fx.spec, "CLAUDE.md"), generatedPrefix);

			const wf = makeWorkflow("spec", fx.spec);
			const { orch, outputs } = makeOrch(wf);
			const typedOrch = orch as unknown as {
				initSpeckitInWorktree: (w: Workflow) => void;
			};
			typedOrch.initSpeckitInWorktree(wf);
			await until(() => outputs.some((o) => o.text.includes("Appended project CLAUDE.md")));

			const afterFirst = readFileSync(join(fx.spec, "CLAUDE.md"), "utf-8");
			// Speckit prefix byte-identical
			expect(afterFirst.slice(0, generatedPrefix.length)).toBe(generatedPrefix);
			// Ends with sep + project bytes
			expect(afterFirst.endsWith(`${PROJECT_CLAUDEMD_SEPARATOR}${projectBytes}`)).toBe(true);

			// SC-003: re-run against the already-prepared worktree is idempotent at
			// the pipeline level (byte-identical file, "already appended" message).
			typedOrch.initSpeckitInWorktree(wf);
			await until(() => outputs.some((o) => o.text.includes("Project CLAUDE.md already appended")));
			const afterSecond = readFileSync(join(fx.spec, "CLAUDE.md"), "utf-8");
			expect(afterSecond).toBe(afterFirst);
		} finally {
			await fx.cleanup();
		}
	});

	test("US3: quick-fix workflow skips append (no separator, no project bytes)", async () => {
		const projectBytes = "# PROJECT_ONLY_PAYLOAD";
		const fx = await makeRepo(projectBytes);
		try {
			const generatedPrefix = "# quick-fix CLAUDE.md\n";
			writeFileSync(join(fx.spec, "CLAUDE.md"), generatedPrefix);

			const wf = makeWorkflow("quick-fix", fx.spec);
			const { orch, outputs, errors } = makeOrch(wf);
			(orch as unknown as { initSpeckitInWorktree: (w: Workflow) => void }).initSpeckitInWorktree(
				wf,
			);
			// Quick-fix routes to `initQuickFixBranch` (never calls the merger). Wait
			// for the branch-creation step to settle before letting `fx.cleanup` run
			// — otherwise in-flight git processes keep the worktree dir busy on
			// Windows and trigger EBUSY during rmSync.
			await until(
				() => outputs.some((o) => o.text.includes("Created fix branch")) || errors.length > 0,
				{ timeoutMs: 10000 },
			);

			const after = readFileSync(join(fx.spec, "CLAUDE.md"), "utf-8");
			expect(after).toBe(generatedPrefix);
			expect(after.includes(PROJECT_CLAUDEMD_SEPARATOR)).toBe(false);
			expect(after.includes(projectBytes)).toBe(false);
		} finally {
			await fx.cleanup();
		}
	});

	test("no-main: non-git spec worktree emits skip notice and does not error", async () => {
		// A plain directory that is NOT a git worktree exercises the `no-main` branch.
		const nonGit = mkdtempSync(join(tmpdir(), "crab-pipe-nogit-"));
		try {
			const generatedPrefix = "# Speckit Generated\n";
			writeFileSync(join(nonGit, "CLAUDE.md"), generatedPrefix);

			const wf = makeWorkflow("spec", nonGit);
			const { orch, outputs, errors } = makeOrch(wf);
			(orch as unknown as { initSpeckitInWorktree: (w: Workflow) => void }).initSpeckitInWorktree(
				wf,
			);
			await until(() => outputs.some((o) => o.text.includes("Could not resolve main worktree")));

			expect(errors.length).toBe(0);
			// Generated file untouched.
			expect(readFileSync(join(nonGit, "CLAUDE.md"), "utf-8")).toBe(generatedPrefix);
			// And no "Appended" line was ever pushed.
			expect(outputs.some((o) => o.text.includes("Appended project CLAUDE.md"))).toBe(false);
		} finally {
			rmSync(nonGit, { recursive: true, force: true });
		}
	});

	test("missing generated CLAUDE.md in spec worktree → workflow enters error state", async () => {
		const fx = await makeRepo("# Project\n");
		try {
			// Ensure the generated file is absent so the merger's readFile throws.
			const generatedPath = join(fx.spec, "CLAUDE.md");
			if (existsSync(generatedPath)) unlinkSync(generatedPath);

			const wf = makeWorkflow("spec", fx.spec);
			const { orch, errors } = makeOrch(wf);
			(orch as unknown as { initSpeckitInWorktree: (w: Workflow) => void }).initSpeckitInWorktree(
				wf,
			);
			await until(() => errors.length > 0, { timeoutMs: 5000 });

			expect(errors[0].text.startsWith("Failed to initialize spec-kit:")).toBe(true);
		} finally {
			await fx.cleanup();
		}
	});
});
