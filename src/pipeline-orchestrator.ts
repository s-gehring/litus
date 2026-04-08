import { readdirSync } from "node:fs";
import { join } from "node:path";
import { AuditLogger } from "./audit-logger";
import { buildFixPrompt, gatherAllFailureLogs } from "./ci-fixer";
import { allFailuresCancelled, type MonitorResult, startMonitoring } from "./ci-monitor";
import type { CLICallbacks } from "./cli-runner";
import { CLIRunner } from "./cli-runner";
import { configStore } from "./config-store";
import { computeDependencyStatus } from "./dependency-resolver";
import { gitSpawn } from "./git-logger";
import {
	mergePr as defaultMergePr,
	resolveConflicts as defaultResolveConflicts,
} from "./pr-merger";
import { QuestionDetector } from "./question-detector";
import { syncRepo as defaultSyncRepo } from "./repo-syncer";
import { ReviewClassifier } from "./review-classifier";
import { runSetupChecks as defaultRunSetupChecks } from "./setup-checker";
import { routeAfterStep as computeRoute, shouldLoopReview } from "./step-router";
import { Summarizer } from "./summarizer";
import {
	type EffortLevel,
	type ModelConfig,
	type PipelineCallbacks,
	type Question,
	type SetupResult,
	STEP,
	type Workflow,
} from "./types";
import { WorkflowEngine } from "./workflow-engine";
import { WorkflowStore } from "./workflow-store";

export type { PipelineCallbacks } from "./types";

// Only steps that invoke the CLI with a configurable model
const STEP_CONFIG_KEY: Record<string, keyof ModelConfig> = {
	[STEP.SPECIFY]: "specify",
	[STEP.CLARIFY]: "clarify",
	[STEP.PLAN]: "plan",
	[STEP.TASKS]: "tasks",
	[STEP.IMPLEMENT]: "implement",
	[STEP.REVIEW]: "review",
	[STEP.IMPLEMENT_REVIEW]: "implementReview",
	[STEP.COMMIT_PUSH_PR]: "commitPushPr",
};

export interface PipelineDeps {
	engine?: WorkflowEngine;
	cliRunner?: CLIRunner;
	questionDetector?: QuestionDetector;
	reviewClassifier?: ReviewClassifier;
	summarizer?: Summarizer;
	auditLogger?: AuditLogger;
	workflowStore?: WorkflowStore;
	mergePr?: typeof defaultMergePr;
	resolveConflicts?: typeof defaultResolveConflicts;
	syncRepo?: typeof defaultSyncRepo;
	runSetupChecks?: (targetDir: string) => Promise<SetupResult>;
	checkoutMaster?: (cwd: string) => Promise<{ code: number; stderr: string }>;
}

const PR_URL_PATTERN = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/g;

function requireWorktreePath(workflow: Workflow): string {
	if (!workflow.worktreePath) {
		throw new Error(
			`Workflow ${workflow.id} has no worktreePath — cannot determine working directory`,
		);
	}
	return workflow.worktreePath;
}

function requireTargetRepository(workflow: Workflow): string {
	if (!workflow.targetRepository) {
		throw new Error(
			`Workflow ${workflow.id} has no targetRepository — cannot determine target directory`,
		);
	}
	return workflow.targetRepository;
}

export function extractPrUrl(output: string): string | null {
	const matches = output.match(PR_URL_PATTERN);
	return matches ? matches[matches.length - 1] : null;
}

export class PipelineOrchestrator {
	private engine: WorkflowEngine;
	private cliRunner: CLIRunner;
	private questionDetector: QuestionDetector;
	private reviewClassifier: ReviewClassifier;
	private summarizer: Summarizer;
	private auditLogger: AuditLogger;
	private store: WorkflowStore;
	private callbacks: PipelineCallbacks;
	private assistantTextBuffer = "";
	private currentAuditRunId: string | null = null;
	private pipelineName: string | null = null;
	private persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private monitorAbortController: AbortController | null = null;
	private mergePrFn: typeof defaultMergePr;
	private resolveConflictsFn: typeof defaultResolveConflicts;
	private syncRepoFn: typeof defaultSyncRepo;
	private runSetupChecksFn: (targetDir: string) => Promise<SetupResult>;
	private checkoutMasterFn: (cwd: string) => Promise<{ code: number; stderr: string }>;

	constructor(callbacks: PipelineCallbacks, deps?: PipelineDeps) {
		this.engine = deps?.engine ?? new WorkflowEngine();
		this.cliRunner = deps?.cliRunner ?? new CLIRunner();
		this.questionDetector = deps?.questionDetector ?? new QuestionDetector();
		this.reviewClassifier = deps?.reviewClassifier ?? new ReviewClassifier();
		this.summarizer = deps?.summarizer ?? new Summarizer();
		this.auditLogger = deps?.auditLogger ?? new AuditLogger();
		this.store = deps?.workflowStore ?? new WorkflowStore();
		this.mergePrFn = deps?.mergePr ?? defaultMergePr;
		this.resolveConflictsFn = deps?.resolveConflicts ?? defaultResolveConflicts;
		this.syncRepoFn = deps?.syncRepo ?? defaultSyncRepo;
		this.runSetupChecksFn = deps?.runSetupChecks ?? defaultRunSetupChecks;
		this.checkoutMasterFn =
			deps?.checkoutMaster ??
			(async (cwd: string) => {
				await gitSpawn(["git", "fetch", "origin", "master"], { cwd });
				const result = await gitSpawn(["git", "checkout", "--detach", "origin/master"], {
					cwd,
				});
				return { code: result.code, stderr: result.stderr };
			});
		this.callbacks = callbacks;
	}

	getEngine(): WorkflowEngine {
		return this.engine;
	}

	/** Start the pipeline for an already-created workflow (used by epic flow). */
	startPipelineFromWorkflow(workflow: Workflow): void {
		this.engine.setWorkflow(workflow);
		this.engine.transition(workflow.id, "running");

		const branchCwd = requireTargetRepository(workflow);
		this.getBranch(branchCwd).then((branch) => {
			this.pipelineName = branch ?? workflow.worktreeBranch;
			this.currentAuditRunId = this.auditLogger.startRun(
				this.pipelineName,
				workflow.worktreeBranch,
			);
		});

		this.persistWorkflow(workflow);
		this.startStep(workflow);

		this.summarizer
			.generateSpecSummary(workflow.specification)
			.then(({ summary, flavor }) => {
				if (summary && !workflow.summary) workflow.summary = summary;
				if (flavor) workflow.flavor = flavor;
				workflow.updatedAt = new Date().toISOString();
				this.persistWorkflow(workflow);
				this.callbacks.onStateChange(workflow.id);
			})
			.catch((err) => {
				console.warn(`[pipeline] Summary generation failed: ${err}`);
			});
	}

	async startPipeline(specification: string, targetRepository: string): Promise<Workflow> {
		const workflow = await this.engine.createWorkflow(specification, targetRepository);
		this.engine.transition(workflow.id, "running");

		const branchCwd = targetRepository;
		this.pipelineName = (await this.getBranch(branchCwd)) ?? workflow.worktreeBranch;
		this.currentAuditRunId = this.auditLogger.startRun(this.pipelineName, workflow.worktreeBranch);

		this.persistWorkflow(workflow);
		this.startStep(workflow);

		this.summarizer
			.generateSpecSummary(specification)
			.then(({ summary, flavor }) => {
				if (summary) workflow.summary = summary;
				if (flavor) workflow.flavor = flavor;
				workflow.updatedAt = new Date().toISOString();
				this.persistWorkflow(workflow);
				this.callbacks.onStateChange(workflow.id);
			})
			.catch((err) => {
				console.warn(`[pipeline] Summary generation failed: ${err}`);
			});

		return workflow;
	}

	private async getBranch(cwd: string): Promise<string | null> {
		try {
			const result = await gitSpawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
			return result.code === 0 && result.stdout ? result.stdout : null;
		} catch {
			return null;
		}
	}

	answerQuestion(workflowId: string, questionId: string, answer: string): void {
		const workflow = this.getWorkflowOrThrow(workflowId);

		if (!workflow.pendingQuestion || workflow.pendingQuestion.id !== questionId) {
			return;
		}

		if (this.currentAuditRunId) {
			const stepName = workflow.steps[workflow.currentStepIndex]?.name ?? null;
			this.auditLogger.logAnswer(this.currentAuditRunId, answer, stepName);
		}

		this.engine.clearQuestion(workflowId);
		const step = workflow.steps[workflow.currentStepIndex];

		// Append the user's answer to step output so it is visible and persisted
		const answerLine = `[Human] ${answer}`;
		step.output += `${answerLine}\n`;
		this.callbacks.onOutput(workflowId, answerLine);

		step.status = "running";
		workflow.updatedAt = new Date().toISOString();

		try {
			this.engine.transition(workflowId, "running");
		} catch (e) {
			if (e instanceof Error && !e.message.includes("Invalid transition")) throw e;
			else console.warn(`[pipeline] Suppressed transition error: ${e}`);
		}

		this.persistWorkflow(workflow);
		this.callbacks.onStateChange(workflowId);

		if (step.name === STEP.SETUP) {
			// User answered the optional warnings prompt — checkout master then advance
			this.checkoutMasterInWorktree(workflow);
			return;
		}

		if (step.name === STEP.MONITOR_CI) {
			if (answer.toLowerCase().includes("abort")) {
				this.handleStepError(workflowId, "Workflow aborted by user after cancelled CI checks");
			} else {
				this.runMonitorCi(workflow);
			}
			return;
		}

		this.assistantTextBuffer = "";
		this.questionDetector.reset();

		// Kill any lingering CLI process before resuming
		this.cliRunner.kill(workflowId);

		const sessionId = step.sessionId;
		if (!sessionId) {
			this.handleStepError(workflowId, "No session ID available to resume after answer");
			return;
		}

		const cwd = requireWorktreePath(workflow);
		const cliCallbacks: CLICallbacks = {
			onOutput: (text) => this.handleStepOutput(workflow.id, text),
			onTools: (tools) => this.callbacks.onTools(workflow.id, tools),
			onComplete: () => this.handleStepComplete(workflow.id),
			onError: (error) => this.handleStepError(workflow.id, error),
			onSessionId: (sid) => this.handleSessionId(workflow.id, sid),
			onPid: (pid) => this.handlePid(workflow.id, pid),
		};

		this.cliRunner.resume(
			workflowId,
			sessionId,
			cwd,
			cliCallbacks,
			this.buildStepEnv(workflow),
			answer,
		);
	}

	skipQuestion(workflowId: string, questionId: string): void {
		this.answerQuestion(
			workflowId,
			questionId,
			"The user has chosen not to answer this question. Continue with your best judgment.",
		);
	}

	resumeMonitorCi(workflowId: string): void {
		const workflow = this.getWorkflowOrThrow(workflowId);
		if (workflow.status !== "running") return;

		const step = workflow.steps[workflow.currentStepIndex];
		if (step.name !== STEP.MONITOR_CI) return;

		this.runMonitorCi(workflow);
	}

	async resumeStep(workflowId: string): Promise<void> {
		const workflow = this.getWorkflowOrThrow(workflowId);
		if (workflow.status !== "running") return;

		const step = workflow.steps[workflow.currentStepIndex];
		if (!step.sessionId) return;

		const cwd = requireWorktreePath(workflow);
		const targetDir = requireTargetRepository(workflow);
		const pipelineName =
			this.pipelineName ?? (await this.getBranch(targetDir)) ?? workflow.worktreeBranch;
		this.currentAuditRunId = this.auditLogger.startRun(pipelineName, workflow.worktreeBranch);

		this.assistantTextBuffer = "";
		this.questionDetector.reset();

		const cliCallbacks: CLICallbacks = {
			onOutput: (text) => this.handleStepOutput(workflow.id, text),
			onTools: (tools) => this.callbacks.onTools(workflow.id, tools),
			onComplete: () => this.handleStepComplete(workflow.id),
			onError: (error) => this.handleStepError(workflow.id, error),
			onSessionId: (sessionId) => this.handleSessionId(workflow.id, sessionId),
			onPid: (pid) => this.handlePid(workflow.id, pid),
		};

		this.cliRunner.resume(
			workflowId,
			step.sessionId,
			cwd,
			cliCallbacks,
			this.buildStepEnv(workflow),
		);
	}

	async retryStep(workflowId: string): Promise<void> {
		const workflow = this.getWorkflowOrThrow(workflowId);

		if (workflow.status !== "error") return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.status = "running";
		step.error = null;
		step.sessionId = null;
		step.startedAt = new Date().toISOString();
		workflow.updatedAt = new Date().toISOString();

		const cwd = requireWorktreePath(workflow);
		const targetDir = requireTargetRepository(workflow);
		const pipelineName =
			this.pipelineName ?? (await this.getBranch(targetDir)) ?? workflow.worktreeBranch;
		this.currentAuditRunId = this.auditLogger.startRun(pipelineName, workflow.worktreeBranch);

		this.engine.transition(workflowId, "running");
		this.callbacks.onStateChange(workflowId);
		this.assistantTextBuffer = "";
		this.questionDetector.reset();

		// Reset step output so it starts fresh
		step.output = "";

		this.persistWorkflow(workflow);
		this.callbacks.onStepChange(
			workflow.id,
			step.name,
			step.name,
			workflow.currentStepIndex,
			workflow.reviewCycle.iteration,
		);

		if (step.name === STEP.SETUP) {
			this.runSetup(workflow);
			return;
		}

		if (step.name === STEP.MONITOR_CI) {
			this.runMonitorCi(workflow);
			return;
		}

		if (step.name === STEP.FIX_CI) {
			this.runFixCi(workflow);
			return;
		}

		if (step.name === STEP.MERGE_PR) {
			this.runMergePr(workflow);
			return;
		}

		if (step.name === STEP.SYNC_REPO) {
			this.runSyncRepo(workflow);
			return;
		}

		const config = configStore.get();
		const configKey = STEP_CONFIG_KEY[step.name];
		this.runStep(
			workflow,
			step.prompt,
			cwd,
			configKey ? config.models[configKey] : undefined,
			configKey ? config.efforts[configKey] : undefined,
		);
	}

	pause(workflowId: string): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId || workflow.status !== "running") return;

		this.cliRunner.kill(workflowId);
		if (this.monitorAbortController) {
			this.monitorAbortController.abort();
			this.monitorAbortController = null;
		}

		const step = workflow.steps[workflow.currentStepIndex];
		step.status = "paused";
		step.pid = null;
		workflow.updatedAt = new Date().toISOString();

		this.engine.transition(workflowId, "paused");
		if (this.persistDebounceTimer) {
			clearTimeout(this.persistDebounceTimer);
			this.persistDebounceTimer = null;
		}
		this.persistWorkflow(workflow);
		this.callbacks.onStateChange(workflowId);
	}

	resume(workflowId: string): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId || workflow.status !== "paused") return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.status = "running";
		workflow.updatedAt = new Date().toISOString();

		this.engine.transition(workflowId, "running");
		this.persistWorkflow(workflow);
		this.callbacks.onStateChange(workflowId);

		this.assistantTextBuffer = "";
		this.questionDetector.reset();

		const cwd = requireWorktreePath(workflow);

		if (step.name === STEP.SETUP) {
			this.runSetup(workflow);
		} else if (step.name === STEP.MONITOR_CI) {
			this.runMonitorCi(workflow);
		} else if (step.sessionId) {
			const cliCallbacks: CLICallbacks = {
				onOutput: (text) => this.handleStepOutput(workflow.id, text),
				onTools: (tools) => this.callbacks.onTools(workflow.id, tools),
				onComplete: () => this.handleStepComplete(workflow.id),
				onError: (error) => this.handleStepError(workflow.id, error),
				onSessionId: (sessionId) => this.handleSessionId(workflow.id, sessionId),
				onPid: (pid) => this.handlePid(workflow.id, pid),
			};
			this.cliRunner.resume(
				workflowId,
				step.sessionId,
				cwd,
				cliCallbacks,
				this.buildStepEnv(workflow),
			);
		} else {
			const config = configStore.get();
			const configKey = STEP_CONFIG_KEY[step.name];
			this.runStep(
				workflow,
				step.prompt,
				cwd,
				configKey ? config.models[configKey] : undefined,
				configKey ? config.efforts[configKey] : undefined,
			);
		}
	}

	cancelPipeline(workflowId: string): void {
		const workflow = this.getWorkflowOrThrow(workflowId);

		if (this.currentAuditRunId) {
			this.auditLogger.endRun(this.currentAuditRunId, { cancelled: true });
			this.currentAuditRunId = null;
		}

		this.cliRunner.kill(workflowId);
		if (this.monitorAbortController) {
			this.monitorAbortController.abort();
			this.monitorAbortController = null;
		}
		this.summarizer.cleanup(workflowId);
		this.questionDetector.reset();
		this.assistantTextBuffer = "";
		this.engine.clearQuestion(workflowId);

		const step = workflow.steps[workflow.currentStepIndex];
		if (
			step.status === "running" ||
			step.status === "waiting_for_input" ||
			step.status === "paused"
		) {
			step.status = "error";
			step.error = "Cancelled by user";
		}

		try {
			this.engine.transition(workflowId, "cancelled");
		} catch (e) {
			if (e instanceof Error && !e.message.includes("Invalid transition")) throw e;
			else console.warn(`[pipeline] Suppressed transition error: ${e}`);
		}

		step.pid = null;
		this.persistWorkflow(workflow);
		this.callbacks.onStateChange(workflowId);

		// Update epic dependency status for siblings if this workflow was cancelled
		if (workflow.epicId && this.callbacks.onEpicDependencyUpdate) {
			this.checkEpicDependencies(workflow).catch((err) => {
				console.error(`[pipeline] Failed to check epic dependencies: ${err}`);
			});
		}
	}

	private startStep(workflow: Workflow): void {
		const step = workflow.steps[workflow.currentStepIndex];
		const previousIndex = workflow.currentStepIndex - 1;
		const previousStep = previousIndex >= 0 ? workflow.steps[previousIndex].name : null;

		step.status = "running";
		step.startedAt = new Date().toISOString();
		step.output = "";
		step.error = null;
		step.sessionId = null;
		step.pid = null;
		workflow.updatedAt = new Date().toISOString();

		this.assistantTextBuffer = "";
		this.questionDetector.reset();

		this.persistWorkflow(workflow);

		this.callbacks.onStepChange(
			workflow.id,
			previousStep,
			step.name,
			workflow.currentStepIndex,
			workflow.reviewCycle.iteration,
		);
		this.callbacks.onStateChange(workflow.id);

		if (step.name === STEP.SETUP) {
			this.runSetup(workflow);
			return;
		}

		if (step.name === STEP.MONITOR_CI) {
			this.runMonitorCi(workflow);
			return;
		}

		if (step.name === STEP.FIX_CI) {
			this.runFixCi(workflow);
			return;
		}

		if (step.name === STEP.MERGE_PR) {
			this.runMergePr(workflow);
			return;
		}

		if (step.name === STEP.SYNC_REPO) {
			this.runSyncRepo(workflow);
			return;
		}

		const cwd = requireWorktreePath(workflow);
		const config = configStore.get();
		const configKey = STEP_CONFIG_KEY[step.name];
		this.runStep(
			workflow,
			step.prompt,
			cwd,
			configKey ? config.models[configKey] : undefined,
			configKey ? config.efforts[configKey] : undefined,
		);
	}

	private runSetup(workflow: Workflow): void {
		const targetDir = requireTargetRepository(workflow);

		this.runSetupChecksFn(targetDir)
			.then((result) => {
				const wf = this.engine.getWorkflow();
				if (!wf || wf.id !== workflow.id) return;

				// Log all check results as output
				for (const check of result.checks) {
					const icon = check.passed ? "✓" : "✗";
					const label = check.required ? "" : " (optional)";
					const msg = check.passed
						? `${icon} ${check.name}${label}`
						: `${icon} ${check.name}${label}: ${check.error}`;
					this.handleStepOutput(wf.id, msg);
				}

				if (!result.passed) {
					// Required checks failed — halt with all failures
					const errors = result.requiredFailures.map((f) => `• ${f.name}: ${f.error}`).join("\n");
					this.handleStepError(wf.id, `Setup failed — fix the following and retry:\n${errors}`);
					return;
				}

				if (result.optionalWarnings.length > 0) {
					// Optional warnings — ask user to skip or fix
					const warnings = result.optionalWarnings.map((w) => `• ${w.name}: ${w.error}`).join("\n");
					this.pauseForQuestion(wf.id, {
						id: `setup-warnings-${Date.now()}`,
						content: `Optional setup warnings:\n${warnings}\n\nYou can continue without fixing these. Type "skip" to proceed or fix the issues and retry.`,
						detectedAt: new Date().toISOString(),
					});
					return;
				}

				// All checks passed, no warnings — checkout latest master then advance
				this.checkoutMasterInWorktree(wf);
			})
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				this.handleStepError(workflow.id, `Setup checks failed: ${msg}`);
			});
	}

	private checkoutMasterInWorktree(workflow: Workflow): void {
		const cwd = requireWorktreePath(workflow);
		this.handleStepOutput(
			workflow.id,
			"[git] fetch + checkout --detach origin/master | cwd=worktree",
		);
		this.checkoutMasterFn(cwd)
			.then((result) => {
				const wf = this.engine.getWorkflow();
				if (!wf || wf.id !== workflow.id) return;

				if (result.code !== 0) {
					const errMsg = result.stderr || `exit code ${result.code}`;
					this.handleStepError(wf.id, `Failed to checkout master in worktree: ${errMsg}`);
					return;
				}
				this.handleStepOutput(wf.id, "✓ Checked out latest master in worktree");
				this.advanceAfterStep(wf.id);
			})
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				this.handleStepError(workflow.id, `Failed to checkout master in worktree: ${msg}`);
			});
	}

	private runMonitorCi(workflow: Workflow): void {
		if (!workflow.prUrl) {
			// Try to discover PR URL from branch
			this.discoverPrUrl(workflow)
				.then((url) => {
					if (!url) {
						this.handleStepError(workflow.id, "No PR URL found — cannot monitor CI checks");
						return;
					}
					workflow.prUrl = url;
					this.persistWorkflow(workflow);
					this.startCiMonitoring(workflow);
				})
				.catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					this.handleStepError(workflow.id, `Failed to discover PR URL: ${msg}`);
				});
			return;
		}

		this.startCiMonitoring(workflow);
	}

	private startCiMonitoring(workflow: Workflow): void {
		workflow.ciCycle.monitorStartedAt =
			workflow.ciCycle.monitorStartedAt ?? new Date().toISOString();
		this.persistWorkflow(workflow);

		this.monitorAbortController = new AbortController();

		startMonitoring(
			workflow.prUrl as string,
			workflow.ciCycle,
			(msg) => this.handleStepOutput(workflow.id, msg),
			this.monitorAbortController.signal,
		)
			.then((result) => this.handleMonitorResult(workflow.id, result))
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				this.handleStepError(workflow.id, `CI monitoring failed: ${msg}`);
			});
	}

	private async discoverPrUrl(workflow: Workflow): Promise<string | null> {
		const cwd = workflow.worktreePath ?? workflow.targetRepository;
		if (!cwd) return null;

		const branch = workflow.featureBranch ?? workflow.worktreeBranch;
		const result = await gitSpawn(
			["gh", "pr", "list", "--head", branch, "--json", "url", "--limit", "1"],
			{ cwd, extra: { branch } },
		);
		if (result.code !== 0) return null;

		try {
			const parsed = JSON.parse(result.stdout);
			if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].url) {
				return parsed[0].url;
			}
		} catch {
			// ignore parse errors
		}
		return null;
	}

	private handleMonitorResult(workflowId: string, result: MonitorResult): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return;

		// If workflow was paused/cancelled while monitoring, ignore the result
		if (workflow.status !== "running") return;

		this.monitorAbortController = null;

		if (result.passed) {
			this.advanceAfterStep(workflowId);
			return;
		}

		workflow.ciCycle.lastCheckResults = result.results;

		// If max attempts already reached, give up
		if (workflow.ciCycle.attempt >= workflow.ciCycle.maxAttempts) {
			const msg = result.timedOut
				? `CI monitoring timed out after ${workflow.ciCycle.attempt} fix attempts`
				: `CI checks still failing after ${workflow.ciCycle.attempt} fix attempts`;
			this.handleStepError(workflowId, msg);
			return;
		}

		if (allFailuresCancelled(result.results)) {
			const cancelled = result.results.filter((r) => r.bucket === "cancel");
			const names = cancelled.map((r) => r.name).join(", ");
			this.pauseForQuestion(workflowId, {
				id: `ci-cancelled-${Date.now()}`,
				content: `All failed CI checks were cancelled (${names}). This may indicate GitHub Actions usage limits. Answer "retry" to re-run monitoring or "abort" to stop the workflow.`,
				detectedAt: new Date().toISOString(),
			});
			return;
		}

		this.advanceToFixCi(workflow);
	}

	private runFixCi(workflow: Workflow): void {
		if (!workflow.prUrl) {
			this.handleStepError(workflow.id, "No PR URL found — cannot fix CI");
			return;
		}

		const failedChecks = workflow.ciCycle.lastCheckResults.filter((r) => r.bucket !== "pass");

		gatherAllFailureLogs(workflow.prUrl, failedChecks)
			.then((logs) => {
				workflow.ciCycle.failureLogs = logs;
				const prUrl = workflow.prUrl as string;
				const prompt = buildFixPrompt(prUrl, logs);
				this.persistWorkflow(workflow);

				const cwd = requireWorktreePath(workflow);
				const config = configStore.get();
				this.runStep(workflow, prompt, cwd, config.models.ciFix, config.efforts.ciFix);
			})
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				this.handleStepError(workflow.id, `Failed to gather CI failure logs: ${msg}`);
			});
	}

	private advanceToFixCi(workflow: Workflow): void {
		const step = workflow.steps[workflow.currentStepIndex];
		step.status = "completed";
		step.completedAt = new Date().toISOString();
		step.pid = null;
		workflow.updatedAt = new Date().toISOString();
		this.flushPersistDebounce(workflow);
		this.persistWorkflow(workflow);

		const fixCiIndex = workflow.steps.findIndex((s) => s.name === STEP.FIX_CI);
		workflow.currentStepIndex = fixCiIndex;
		this.startStep(workflow);
	}

	private runStep(
		workflow: Workflow,
		prompt: string,
		cwd: string,
		model?: string,
		effort?: EffortLevel,
	): void {
		const stepWorkflow: Workflow = {
			...workflow,
			specification: prompt,
			worktreePath: cwd,
		};

		const cliCallbacks: CLICallbacks = {
			onOutput: (text) => this.handleStepOutput(workflow.id, text),
			onTools: (tools) => this.callbacks.onTools(workflow.id, tools),
			onComplete: () => this.handleStepComplete(workflow.id),
			onError: (error) => this.handleStepError(workflow.id, error),
			onSessionId: (sessionId) => this.handleSessionId(workflow.id, sessionId),
			onPid: (pid) => this.handlePid(workflow.id, pid),
		};

		this.cliRunner.start(stepWorkflow, cliCallbacks, this.buildStepEnv(workflow), model, effort);
	}

	private handleStepOutput(workflowId: string, text: string): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.output += `${text}\n`;
		workflow.updatedAt = new Date().toISOString();

		this.engine.updateLastOutput(workflowId, text);
		this.callbacks.onOutput(workflowId, text);
		this.persistDebounced(workflow);

		this.assistantTextBuffer += `${text}\n`;

		this.summarizer.maybeSummarize(workflowId, text, (stepSummary) => {
			try {
				this.engine.updateStepSummary(workflowId, stepSummary);
				this.callbacks.onStateChange(workflowId);
			} catch (e) {
				if (e instanceof Error && !e.message.includes("not found")) throw e;
			}
		});
	}

	private handleStepComplete(workflowId: string): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return;

		const candidate = this.questionDetector.detect(this.assistantTextBuffer);
		if (candidate) {
			this.questionDetector
				.classifyWithHaiku(candidate.content)
				.then((isQuestion) => {
					if (!isQuestion) {
						this.advanceAfterStep(workflowId);
						return;
					}
					this.pauseForQuestion(workflowId, candidate);
				})
				.catch((err) => {
					console.warn(`[pipeline] Haiku classification failed, advancing: ${err}`);
					this.advanceAfterStep(workflowId);
				});
		} else {
			this.advanceAfterStep(workflowId);
		}
	}

	private pauseForQuestion(workflowId: string, question: Question): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId || workflow.status !== "running") return;

		// Auto-mode: answer immediately instead of pausing
		if (configStore.get().autoMode) {
			const isSetupWarning = question.id.startsWith("setup-warnings-");
			const autoAnswer = isSetupWarning
				? "skip"
				: "The user has chosen not to answer this question. Continue with your best judgment.";
			this.handleStepOutput(workflowId, `[auto-mode] Auto-answering: "${autoAnswer}"`);
			// Set the question so answerQuestion's guard check passes
			this.engine.setQuestion(workflowId, question);
			this.answerQuestion(workflowId, question.id, autoAnswer);
			return;
		}

		if (this.currentAuditRunId) {
			const stepName = workflow.steps[workflow.currentStepIndex]?.name ?? null;
			this.auditLogger.logQuery(this.currentAuditRunId, question.content, stepName);
		}

		const step = workflow.steps[workflow.currentStepIndex];
		step.status = "waiting_for_input";
		workflow.updatedAt = new Date().toISOString();

		this.engine.setQuestion(workflowId, question);
		try {
			this.engine.transition(workflowId, "waiting_for_input");
		} catch (e) {
			if (e instanceof Error && !e.message.includes("Invalid transition")) throw e;
			else console.warn(`[pipeline] Suppressed transition error: ${e}`);
		}

		this.flushPersistDebounce(workflow);
		this.persistWorkflow(workflow);
		this.callbacks.onStateChange(workflowId);
	}

	private advanceAfterStep(workflowId: string): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.status = "completed";
		step.completedAt = new Date().toISOString();
		step.pid = null;
		workflow.updatedAt = new Date().toISOString();

		// Reset activity buffer between steps so the next step starts fresh
		this.summarizer.resetBuffer(workflowId);

		if (step.name === STEP.COMMIT_PUSH_PR) {
			const url = extractPrUrl(step.output);
			if (url) workflow.prUrl = url;
		}

		// After specify completes, detect the feature branch and rename
		// the worktree directory to match the feature branch name.
		// Await rename before routing to next step so worktreePath is settled.
		if (step.name === STEP.SPECIFY && workflow.worktreePath) {
			this.detectFeatureBranch(workflow);
			if (this.shouldRenameWorktree(workflow)) {
				this.renameWorktreeToFeatureBranch(workflow).then(() => {
					this.routeAfterStep(workflow);
				});
				return;
			}
		}

		this.routeAfterStep(workflow);
	}

	/** Persist and route to the appropriate next step after completion. */
	private routeAfterStep(workflow: Workflow): void {
		this.flushPersistDebounce(workflow);
		this.persistWorkflow(workflow);

		const decision = computeRoute(workflow);

		switch (decision.action) {
			case "route-to-monitor-ci": {
				const monitorIndex = workflow.steps.findIndex((s) => s.name === STEP.MONITOR_CI);
				workflow.currentStepIndex = monitorIndex;
				this.startStep(workflow);
				return;
			}
			case "route-to-merge-pr": {
				const mergePrIndex = workflow.steps.findIndex((s) => s.name === STEP.MERGE_PR);
				workflow.currentStepIndex = mergePrIndex;
				this.startStep(workflow);
				return;
			}
			case "route-back-to-monitor":
				this.routeBackToMonitor(workflow);
				return;
			case "route-to-sync-repo": {
				const syncRepoIndex = workflow.steps.findIndex((s) => s.name === STEP.SYNC_REPO);
				workflow.currentStepIndex = syncRepoIndex;
				this.startStep(workflow);
				return;
			}
			case "complete":
				this.completeWorkflow(workflow);
				return;
			case "route-to-implement-review":
				this.routeToImplementReview(workflow);
				return;
			case "handle-implement-review-complete":
				this.handleImplementReviewComplete(workflow).catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`[pipeline] Implement-review completion error: ${msg}`);
					this.handleStepError(workflow.id, msg);
				});
				return;
			case "advance-to-next":
				this.advanceToNextStep(workflow);
				return;
		}
	}

	private routeToImplementReview(workflow: Workflow): void {
		workflow.reviewCycle.iteration++;

		const implReviewIndex = workflow.steps.findIndex((s) => s.name === STEP.IMPLEMENT_REVIEW);

		// Reset implement-review step for re-use
		const implStep = workflow.steps[implReviewIndex];
		implStep.status = "pending";
		implStep.output = "";
		implStep.error = null;
		implStep.sessionId = null;
		implStep.startedAt = null;
		implStep.completedAt = null;
		implStep.pid = null;

		workflow.currentStepIndex = implReviewIndex;
		this.persistWorkflow(workflow);
		this.startStep(workflow);
	}

	private async handleImplementReviewComplete(workflow: Workflow): Promise<void> {
		// Classify the review step's output to decide whether to loop
		const reviewIndex = workflow.steps.findIndex((s) => s.name === STEP.REVIEW);
		const reviewStep = workflow.steps[reviewIndex];
		const severity = await this.reviewClassifier.classify(reviewStep.output);

		workflow.reviewCycle.lastSeverity = severity;
		workflow.updatedAt = new Date().toISOString();

		if (
			shouldLoopReview(severity, workflow.reviewCycle.iteration, workflow.reviewCycle.maxIterations)
		) {
			// Reset review step and loop back
			const step = workflow.steps[reviewIndex];
			step.status = "pending";
			step.output = "";
			step.error = null;
			step.sessionId = null;
			step.startedAt = null;
			step.completedAt = null;
			step.pid = null;

			workflow.currentStepIndex = reviewIndex;
			this.persistWorkflow(workflow);
			this.startStep(workflow);
		} else {
			workflow.currentStepIndex = workflow.steps.findIndex((s) => s.name === STEP.COMMIT_PUSH_PR);
			this.startStep(workflow);
		}
	}

	private routeBackToMonitor(workflow: Workflow): void {
		workflow.ciCycle.attempt++;
		workflow.ciCycle.monitorStartedAt = null;
		workflow.ciCycle.failureLogs = [];

		const monitorIndex = workflow.steps.findIndex((s) => s.name === STEP.MONITOR_CI);
		const monitorStep = workflow.steps[monitorIndex];
		monitorStep.status = "pending";
		monitorStep.output = "";
		monitorStep.error = null;
		monitorStep.sessionId = null;
		monitorStep.startedAt = null;
		monitorStep.completedAt = null;
		monitorStep.pid = null;

		workflow.currentStepIndex = monitorIndex;
		this.persistWorkflow(workflow);
		this.startStep(workflow);
	}

	private runMergePr(workflow: Workflow): void {
		if (!workflow.prUrl) {
			this.handleStepError(workflow.id, "No PR URL found — cannot merge PR");
			return;
		}

		// Initialize merge cycle on first entry
		if (workflow.mergeCycle.attempt === 0) {
			workflow.mergeCycle.attempt = 1;
			this.persistWorkflow(workflow);
		}

		const cwd = requireWorktreePath(workflow);

		this.mergePrFn(workflow.prUrl, cwd, (msg) => this.handleStepOutput(workflow.id, msg))
			.then((result) => this.handleMergeResult(workflow.id, result))
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				this.handleStepError(workflow.id, `PR merge failed: ${msg}`);
			});
	}

	private handleMergeResult(workflowId: string, result: import("./types").MergeResult): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return;

		if (result.merged || result.alreadyMerged) {
			// Success — advance to sync-repo
			this.advanceAfterStep(workflowId);
			return;
		}

		if (result.conflict) {
			// Check if merge cycle exhausted
			if (workflow.mergeCycle.attempt >= workflow.mergeCycle.maxAttempts) {
				this.handleStepError(
					workflowId,
					`Merge conflicts persist after ${workflow.mergeCycle.attempt} resolution attempts`,
				);
				return;
			}

			// Resolve conflicts and loop back to monitor-ci
			const cwd = requireWorktreePath(workflow);
			this.resolveConflictsFn(cwd, workflow.summary || workflow.specification, (msg) =>
				this.handleStepOutput(workflow.id, msg),
			)
				.then(() => {
					workflow.mergeCycle.attempt++;
					this.routeBackToMonitor(workflow);
				})
				.catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					this.handleStepError(workflowId, `Conflict resolution failed: ${msg}`);
				});
			return;
		}

		// Non-conflict error
		this.handleStepError(workflowId, result.error || "PR merge failed");
	}

	private runSyncRepo(workflow: Workflow): void {
		const targetRepo = requireTargetRepository(workflow);

		this.syncRepoFn(targetRepo, workflow.worktreePath, this.engine, workflow.id, (msg) =>
			this.handleStepOutput(workflow.id, msg),
		)
			.then((result) => {
				if (result.worktreeRemoved) {
					workflow.worktreePath = null;
				}
				if (result.warning) {
					this.handleStepOutput(workflow.id, `Warning: ${result.warning}`);
				}
				// sync-repo always completes the workflow
				this.advanceAfterStep(workflow.id);
			})
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				// Even on error, sync-repo completes (PR is already merged)
				this.handleStepOutput(workflow.id, `Warning: sync failed: ${msg}`);
				this.advanceAfterStep(workflow.id);
			});
	}

	private completeWorkflow(workflow: Workflow): void {
		if (this.currentAuditRunId) {
			this.auditLogger.endRun(this.currentAuditRunId, {
				totalSteps: workflow.steps.length,
				reviewIterations: workflow.reviewCycle.iteration,
			});
			this.currentAuditRunId = null;
		}
		try {
			this.engine.transition(workflow.id, "completed");
		} catch (e) {
			if (e instanceof Error && !e.message.includes("Invalid transition")) throw e;
			else console.warn(`[pipeline] Suppressed transition error: ${e}`);
		}
		this.cliRunner.kill(workflow.id);
		this.summarizer.cleanup(workflow.id);
		this.persistWorkflow(workflow);
		this.callbacks.onComplete(workflow.id);
		this.callbacks.onStateChange(workflow.id);

		// Check epic dependencies — notify server to resolve dependent workflows
		if (workflow.epicId && this.callbacks.onEpicDependencyUpdate) {
			this.checkEpicDependencies(workflow).catch((err) => {
				console.error(`[pipeline] Failed to check epic dependencies: ${err}`);
			});
		}
	}

	private async checkEpicDependencies(triggerWorkflow: Workflow): Promise<void> {
		if (!triggerWorkflow.epicId) return;

		const allWorkflows = await this.store.loadAll();
		const siblings = allWorkflows.filter(
			(w) => w.epicId === triggerWorkflow.epicId && w.id !== triggerWorkflow.id,
		);

		// Build sets of completed and errored workflow IDs
		const completedIds = new Set<string>();
		const errorIds = new Set<string>();
		for (const w of allWorkflows) {
			if (w.epicId === triggerWorkflow.epicId) {
				if (w.status === "completed") completedIds.add(w.id);
				if (w.status === "error" || w.status === "cancelled") errorIds.add(w.id);
			}
		}
		// The trigger workflow just completed — ensure it's in the set even if
		// the fire-and-forget persist hasn't flushed to disk yet.
		completedIds.add(triggerWorkflow.id);

		for (const sibling of siblings) {
			if (!sibling.epicDependencies.includes(triggerWorkflow.id)) continue;
			if (sibling.status !== "waiting_for_dependencies") continue;

			const depStatus = computeDependencyStatus(sibling.epicDependencies, completedIds, errorIds);

			sibling.epicDependencyStatus = depStatus.status;
			sibling.updatedAt = new Date().toISOString();
			await this.store.save(sibling);

			this.callbacks.onEpicDependencyUpdate?.(sibling.id, depStatus.status, depStatus.blocking);
		}
	}

	/**
	 * Scan the worktree's specs/ directory for the newest feature directory
	 * and store its name as the feature branch.  This is used to set
	 * SPECIFY_FEATURE for subsequent steps and to rename the worktree.
	 */
	private detectFeatureBranch(workflow: Workflow): void {
		const specsDir = join(workflow.worktreePath as string, "specs");
		try {
			const entries = readdirSync(specsDir, { withFileTypes: true });
			let best: string | null = null;
			let bestNum = -1;
			let bestTs = "";
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const seqMatch = entry.name.match(/^(\d{3,})-/);
				const tsMatch = entry.name.match(/^(\d{8}-\d{6})-/);
				if (tsMatch) {
					if (tsMatch[1] > bestTs) {
						bestTs = tsMatch[1];
						best = entry.name;
					}
				} else if (seqMatch) {
					const num = Number.parseInt(seqMatch[1], 10);
					if (num > bestNum) {
						bestNum = num;
						if (!bestTs) best = entry.name; // timestamp dirs win
					}
				}
			}
			if (best) {
				workflow.featureBranch = best;
				console.log(`[pipeline] Detected feature branch: ${best}`);
			}
		} catch {
			// specs/ directory might not exist yet — not fatal
		}
	}

	/** Check whether a worktree rename is needed (synchronous precondition check). */
	private shouldRenameWorktree(workflow: Workflow): boolean {
		if (!workflow.featureBranch || !workflow.worktreePath || !workflow.targetRepository)
			return false;
		const dirName = workflow.worktreePath.split(/[/\\]/).pop() ?? "";
		return dirName.startsWith("tmp-");
	}

	/**
	 * After detectFeatureBranch() sets workflow.featureBranch, rename the
	 * worktree directory from its temp name (tmp-{uuid}) to match the branch.
	 * Non-fatal: if the rename fails, the workflow continues with the old path.
	 * Caller must check shouldRenameWorktree() first.
	 */
	private async renameWorktreeToFeatureBranch(workflow: Workflow): Promise<void> {
		const worktreePath = workflow.worktreePath as string;
		const targetRepo = workflow.targetRepository as string;
		const newRelativePath = `.worktrees/${workflow.featureBranch}`;

		try {
			const newAbsPath = await this.engine.moveWorktree(worktreePath, newRelativePath, targetRepo);
			workflow.worktreePath = newAbsPath;
			workflow.worktreeBranch = workflow.featureBranch as string;
			this.persistWorkflow(workflow);
			this.callbacks.onStateChange(workflow.id);
			console.log(`[pipeline] Renamed worktree to ${newRelativePath}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[pipeline] Worktree rename failed (non-fatal): ${msg}`);
		}
	}

	/** Build extra env vars to inject into CLI processes. */
	private buildStepEnv(workflow: Workflow): Record<string, string> | undefined {
		if (workflow.featureBranch) {
			return { SPECIFY_FEATURE: workflow.featureBranch };
		}
		return undefined;
	}

	private advanceToNextStep(workflow: Workflow): void {
		const nextIndex = workflow.currentStepIndex + 1;

		if (nextIndex >= workflow.steps.length) {
			this.completeWorkflow(workflow);
			return;
		}

		workflow.currentStepIndex = nextIndex;
		this.startStep(workflow);
	}

	private handleStepError(workflowId: string, error: string): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return;

		this.summarizer.cleanup(workflowId);

		if (this.currentAuditRunId) {
			this.auditLogger.endRun(this.currentAuditRunId, { error });
			this.currentAuditRunId = null;
		}

		const step = workflow.steps[workflow.currentStepIndex];
		step.status = "error";
		step.error = error;
		step.pid = null;
		workflow.updatedAt = new Date().toISOString();

		try {
			this.engine.transition(workflowId, "error");
		} catch (e) {
			if (e instanceof Error && !e.message.includes("Invalid transition")) throw e;
			else console.warn(`[pipeline] Suppressed transition error: ${e}`);
		}

		this.flushPersistDebounce(workflow);
		this.persistWorkflow(workflow);
		this.callbacks.onError(workflowId, error);
		this.callbacks.onStateChange(workflowId);

		// Update epic dependency status for siblings if this workflow errored
		if (workflow.epicId && this.callbacks.onEpicDependencyUpdate) {
			this.checkEpicDependencies(workflow).catch((err) => {
				console.error(`[pipeline] Failed to check epic dependencies: ${err}`);
			});
		}
	}

	private handlePid(workflowId: string, pid: number): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.pid = pid;
		this.persistWorkflow(workflow);
	}

	private handleSessionId(workflowId: string, sessionId: string): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.sessionId = sessionId;
		this.persistWorkflow(workflow);
	}

	private persistWorkflow(workflow: Workflow): void {
		this.store.save(workflow).catch((err) => {
			console.error(`[pipeline] Failed to persist workflow: ${err}`);
		});
	}

	private persistDebounced(workflow: Workflow): void {
		if (this.persistDebounceTimer) {
			clearTimeout(this.persistDebounceTimer);
		}
		this.persistDebounceTimer = setTimeout(() => {
			this.persistDebounceTimer = null;
			this.persistWorkflow(workflow);
		}, 3000);
	}

	private flushPersistDebounce(workflow: Workflow): void {
		if (this.persistDebounceTimer) {
			clearTimeout(this.persistDebounceTimer);
			this.persistDebounceTimer = null;
			this.persistWorkflow(workflow);
		}
	}

	getStore(): WorkflowStore {
		return this.store;
	}

	private getWorkflowOrThrow(workflowId: string): Workflow {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) {
			throw new Error(`Workflow ${workflowId} not found`);
		}
		return workflow;
	}
}
