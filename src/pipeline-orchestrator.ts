import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { AuditLogger } from "./audit-logger";
import { buildFixPrompt, gatherAllFailureLogs } from "./ci-fixer";
import { allFailuresCancelled, type MonitorResult, startMonitoring } from "./ci-monitor";
import { CIMonitorCoordinator } from "./ci-monitor-coordinator";
import type { CLICallbacks } from "./cli-runner";
import { CLIRunner } from "./cli-runner";
import { CLIStepRunner } from "./cli-step-runner";
import { configStore } from "./config-store";
import { computeDependencyStatus } from "./dependency-resolver";
import { toErrorMessage } from "./errors";
import {
	buildFeedbackPrompt,
	detectNewCommits,
	parseAgentResult,
	reconcileOutcome,
} from "./feedback-implementer";
import { buildFeedbackContext } from "./feedback-injector";
import { gitSpawn } from "./git-logger";
import { logger } from "./logger";
import type { ManagedRepoStore } from "./managed-repo-store";
import {
	mergePr as defaultMergePr,
	resolveConflicts as defaultResolveConflicts,
} from "./pr-merger";
import { QuestionDetector } from "./question-detector";
import { syncRepo as defaultSyncRepo } from "./repo-syncer";
import { ReviewClassifier } from "./review-classifier";
import {
	ensureSpeckitSkills as defaultEnsureSpeckitSkills,
	runSetupChecks as defaultRunSetupChecks,
} from "./setup-checker";
import { routeAfterStep as computeRoute, shouldLoopReview } from "./step-router";
import { Summarizer } from "./summarizer";
import {
	type AlertType,
	type EffortLevel,
	type FeedbackEntry,
	type ModelConfig,
	type PipelineCallbacks,
	type PipelineStep,
	type PipelineStepName,
	type Question,
	type SetupResult,
	STEP,
	shouldAutoAnswer,
	shouldPauseBeforeMerge,
	type Workflow,
	type WorkflowStatus,
} from "./types";
import { snapshotStepArtifacts } from "./workflow-artifacts";
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
	managedRepoStore?: ManagedRepoStore;
	mergePr?: typeof defaultMergePr;
	resolveConflicts?: typeof defaultResolveConflicts;
	/** Overrides the PR-URL discovery path in `runMonitorCi`. Test-only hook. */
	discoverPrUrl?: (workflow: Workflow) => Promise<string | null>;
	syncRepo?: typeof defaultSyncRepo;
	runSetupChecks?: (targetDir: string) => Promise<SetupResult>;
	ensureSpeckitSkills?: typeof defaultEnsureSpeckitSkills;
	checkoutMaster?: (cwd: string) => Promise<{ code: number; stderr: string }>;
	/** Returns the git HEAD SHA at the worktree, or null on failure. Overridable in tests. */
	getGitHead?: (cwd: string) => Promise<string | null>;
	/** Returns new commit SHAs in `preRunHead..HEAD` order. Overridable in tests. */
	detectNewCommits?: (preRunHead: string, cwd: string) => Promise<string[]>;
	/** Override per-step output cap (default `MAX_STEP_OUTPUT_CHARS`). Test-only. */
	maxStepOutputChars?: number;
}

const PR_URL_PATTERN = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/g;

// Per-step budget spanning archived runs + current run. When combined length
// of `sum(history[*].output)` + `step.output` exceeds this, the oldest history
// entry is dropped wholesale; repeated overflow drops further entries; only
// when history is empty do we head-truncate `step.output`.
export const MAX_STEP_OUTPUT_CHARS = 1_000_000;

/**
 * Enforce the per-step output cap across `step.history[*].output` + `step.output`.
 * Mutates `step` in place. Exported for unit testing; orchestrator calls this
 * after each output append.
 */
export function enforceStepOutputCap(
	step: Pick<PipelineStep, "history" | "output">,
	cap: number = MAX_STEP_OUTPUT_CHARS,
): void {
	let historyLen = step.history.reduce((n, h) => n + h.output.length, 0);
	while (step.history.length > 0 && historyLen + step.output.length > cap) {
		const dropped = step.history.shift();
		if (dropped) historyLen -= dropped.output.length;
	}
	if (step.output.length > cap) {
		step.output = step.output.slice(step.output.length - cap);
	}
}

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
	private stepRunner: CLIStepRunner;
	private ciMonitor: CIMonitorCoordinator;
	private questionDetector: QuestionDetector;
	private reviewClassifier: ReviewClassifier;
	private summarizer: Summarizer;
	private auditLogger: AuditLogger;
	private store: WorkflowStore;
	private managedRepoStore: ManagedRepoStore | null;
	private callbacks: PipelineCallbacks;
	private assistantTextBuffer = "";
	private currentAuditRunId: string | null = null;
	private pipelineName: string | null = null;
	private persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private mergePrFn: typeof defaultMergePr;
	private resolveConflictsFn: typeof defaultResolveConflicts;
	private syncRepoFn: typeof defaultSyncRepo;
	private runSetupChecksFn: (targetDir: string) => Promise<SetupResult>;
	private ensureSpeckitSkillsFn: typeof defaultEnsureSpeckitSkills;
	private checkoutMasterFn: (cwd: string) => Promise<{ code: number; stderr: string }>;
	private getGitHeadFn: (cwd: string) => Promise<string | null>;
	private detectNewCommitsFn: (preRunHead: string, cwd: string) => Promise<string[]>;
	private maxStepOutputChars: number;

	constructor(callbacks: PipelineCallbacks, deps?: PipelineDeps) {
		this.engine = deps?.engine ?? new WorkflowEngine();
		this.cliRunner = deps?.cliRunner ?? new CLIRunner();
		this.stepRunner = new CLIStepRunner(this.cliRunner);
		const discoverPrUrlFn = deps?.discoverPrUrl ?? ((w: Workflow) => this.discoverPrUrl(w));
		this.ciMonitor = new CIMonitorCoordinator(startMonitoring, discoverPrUrlFn);
		this.questionDetector = deps?.questionDetector ?? new QuestionDetector();
		this.reviewClassifier = deps?.reviewClassifier ?? new ReviewClassifier();
		this.summarizer = deps?.summarizer ?? new Summarizer();
		this.auditLogger = deps?.auditLogger ?? new AuditLogger();
		this.store = deps?.workflowStore ?? new WorkflowStore();
		this.managedRepoStore = deps?.managedRepoStore ?? null;
		this.mergePrFn = deps?.mergePr ?? defaultMergePr;
		this.resolveConflictsFn = deps?.resolveConflicts ?? defaultResolveConflicts;
		this.syncRepoFn = deps?.syncRepo ?? defaultSyncRepo;
		this.runSetupChecksFn = deps?.runSetupChecks ?? defaultRunSetupChecks;
		this.ensureSpeckitSkillsFn = deps?.ensureSpeckitSkills ?? defaultEnsureSpeckitSkills;
		this.checkoutMasterFn =
			deps?.checkoutMaster ??
			(async (cwd: string) => {
				await gitSpawn(["git", "fetch", "origin", "master"], { cwd });
				const result = await gitSpawn(["git", "checkout", "--detach", "origin/master"], {
					cwd,
				});
				return { code: result.code, stderr: result.stderr };
			});
		this.getGitHeadFn =
			deps?.getGitHead ??
			(async (cwd: string) => {
				try {
					const r = await gitSpawn(["git", "rev-parse", "HEAD"], { cwd });
					return r.code === 0 ? r.stdout.trim() : null;
				} catch {
					return null;
				}
			});
		this.detectNewCommitsFn = deps?.detectNewCommits ?? detectNewCommits;
		this.maxStepOutputChars = deps?.maxStepOutputChars ?? MAX_STEP_OUTPUT_CHARS;
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
				logger.warn(`[pipeline] Summary generation failed: ${err}`);
			});
	}

	async startPipeline(
		specification: string,
		targetRepository: string,
		managedRepo: Workflow["managedRepo"] = null,
	): Promise<Workflow> {
		const workflow = await this.engine.createWorkflow(specification, targetRepository, managedRepo);
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
				logger.warn(`[pipeline] Summary generation failed: ${err}`);
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
		this.clearQuestionAlert(workflowId);
		const step = workflow.steps[workflow.currentStepIndex];

		// Append the user's answer to step output so it is visible and persisted
		const answerLine = `[Human] ${answer}`;
		step.output += `${answerLine}\n`;
		this.callbacks.onOutput(workflowId, answerLine);

		step.status = "running";
		workflow.updatedAt = new Date().toISOString();

		this.tryTransition(workflowId, "running");

		this.persistWorkflow(workflow);
		this.callbacks.onStateChange(workflowId);

		if (step.name === STEP.SETUP) {
			// User answered the optional warnings prompt — create worktree, checkout master then advance
			this.createWorktreeAndCheckout(workflow);
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

		this.resetStepState();

		// Kill any lingering CLI process before resuming
		this.stepRunner.killProcess(workflowId);

		const sessionId = step.sessionId;
		if (!sessionId) {
			this.handleStepError(workflowId, "No session ID available to resume after answer");
			return;
		}

		const cwd = requireWorktreePath(workflow);
		this.stepRunner.resumeStep(
			workflowId,
			sessionId,
			cwd,
			this.buildStepCallbacks(workflowId),
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

		this.resetStepState();

		this.stepRunner.resumeStep(
			workflowId,
			step.sessionId,
			cwd,
			this.buildStepCallbacks(workflowId),
			this.buildStepEnv(workflow),
		);
	}

	async retryStep(workflowId: string): Promise<void> {
		const workflow = this.getWorkflowOrThrow(workflowId);

		if (workflow.status !== "error") return;

		const step = workflow.steps[workflow.currentStepIndex];

		// Feedback-implementer has no retry path: a failed FI run rewinds to the
		// merge-pr pause and invites the user to submit fresh feedback (FR-012).
		// If a future refactor ever routes an FI failure to workflow.status=error,
		// this guard keeps retryStep from spawning a CLI with the step's empty
		// static prompt (types.ts PIPELINE_STEP_DEFINITIONS) and skipping feedback
		// context injection (runStep treats FI as a pre-built prompt).
		if (step.name === STEP.FEEDBACK_IMPLEMENTER) {
			logger.warn(
				`[pipeline] retryStep called on feedback-implementer for workflow ${workflowId}; FI cannot be retried — submit new feedback instead`,
			);
			return;
		}

		this.stepRunner.resetStep(step);
		workflow.updatedAt = new Date().toISOString();

		const targetDir = requireTargetRepository(workflow);
		const pipelineName =
			this.pipelineName ?? (await this.getBranch(targetDir)) ?? workflow.worktreeBranch;
		this.currentAuditRunId = this.auditLogger.startRun(pipelineName, workflow.worktreeBranch);

		this.engine.transition(workflowId, "running");
		this.callbacks.onStateChange(workflowId);
		this.resetStepState();

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
			workflow.mergeCycle.attempt = 0;
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

	pause(workflowId: string): void {
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow || workflow.status !== "running") return;

		this.stepRunner.killProcess(workflowId);
		this.ciMonitor.abort();

		const step = workflow.steps[workflow.currentStepIndex];
		step.status = "paused";
		step.pid = null;
		workflow.updatedAt = new Date().toISOString();

		this.engine.transition(workflowId, "paused");
		this.flushPersistDebounce();
		this.persistWorkflow(workflow);
		this.callbacks.onStateChange(workflowId);
	}

	resume(workflowId: string): void {
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow || workflow.status !== "paused") return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.status = "running";
		workflow.updatedAt = new Date().toISOString();

		this.engine.transition(workflowId, "running");
		this.persistWorkflow(workflow);
		this.callbacks.onStateChange(workflowId);

		this.resetStepState();

		if (step.name === STEP.SETUP) {
			this.runSetup(workflow);
			return;
		}

		const cwd = requireWorktreePath(workflow);

		if (step.name === STEP.MONITOR_CI) {
			this.runMonitorCi(workflow);
		} else if (step.name === STEP.FIX_CI) {
			this.runFixCi(workflow);
		} else if (step.name === STEP.FEEDBACK_IMPLEMENTER) {
			if (step.sessionId) {
				this.stepRunner.resumeStep(
					workflowId,
					step.sessionId,
					cwd,
					this.buildStepCallbacks(workflowId),
					this.buildStepEnv(workflow),
				);
			} else {
				this.runFeedbackImplementer(workflow).catch((err) => {
					this.handleStepError(workflowId, toErrorMessage(err));
				});
			}
		} else if (step.name === STEP.MERGE_PR) {
			workflow.mergeCycle.attempt = 0;
			this.runMergePr(workflow);
		} else if (step.name === STEP.SYNC_REPO) {
			this.runSyncRepo(workflow);
		} else if (step.sessionId) {
			this.stepRunner.resumeStep(
				workflowId,
				step.sessionId,
				cwd,
				this.buildStepCallbacks(workflowId),
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

		this.stepRunner.killProcess(workflowId);
		this.ciMonitor.abort();
		this.summarizer.cleanup(workflowId);
		this.resetStepState();
		this.engine.clearQuestion(workflowId);
		this.clearQuestionAlert(workflowId);

		const step = workflow.steps[workflow.currentStepIndex];

		// If aborting a feedback-implementer run, record the in-flight entry as cancelled
		// (FR-019). Git-based commit detection runs fire-and-forget — the outcome is
		// immediately persisted with commitRefs: [] and backfilled when detection resolves.
		if (step.name === STEP.FEEDBACK_IMPLEMENTER) {
			const latest = workflow.feedbackEntries[workflow.feedbackEntries.length - 1];
			if (latest && latest.outcome === null) {
				latest.outcome = {
					value: "cancelled",
					summary: "Cancelled by user abort",
					commitRefs: [],
					warnings: [],
				};
				const preRunHead = workflow.feedbackPreRunHead;
				const cwd = workflow.worktreePath;
				if (preRunHead && cwd) {
					this.detectNewCommitsFn(preRunHead, cwd)
						.then((commits) => {
							if (latest.outcome && commits.length > 0) {
								latest.outcome.commitRefs = commits;
								workflow.updatedAt = new Date().toISOString();
								this.persistWorkflow(workflow);
								this.callbacks.onStateChange(workflowId);
							}
						})
						.catch((err) => {
							// Best-effort commit backfill — agent already cancelled.
							// Surface the failure so a missing commitRefs on a cancelled
							// entry can be traced back to this path instead of silently
							// showing []. Production detectNewCommits swallows its own
							// errors; this fires only when a custom/test-injected fn throws.
							logger.warn(
								`[pipeline] Post-cancel commit backfill failed for workflow ${workflowId}: ${toErrorMessage(err)}`,
							);
						});
				}
			}
			workflow.feedbackPreRunHead = null;
		}

		if (
			step.status === "running" ||
			step.status === "waiting_for_input" ||
			step.status === "paused"
		) {
			step.status = "error";
			step.error = "Cancelled by user";
		}

		this.tryTransition(workflowId, "cancelled");

		step.pid = null;
		this.flushPersistDebounce();
		this.persistWorkflow(workflow);
		this.callbacks.onStateChange(workflowId);

		// If this workflow cloned from a URL, release the managed-repo refcount so the
		// clone is cleaned up once it has no remaining consumers. sync-repo (which is
		// the release hook for normal completion) does not run on cancel.
		this.releaseManagedRepoIfAny(workflow);

		// Update epic dependency status for siblings if this workflow was cancelled,
		// and emit `epic-finished` when every sibling has reached a terminal state.
		if (workflow.epicId) {
			this.checkEpicDependencies(workflow).catch((err) => {
				logger.error(`[pipeline] Failed to check epic dependencies: ${err}`);
			});
		}
	}

	/**
	 * Accept a feedback submission on a manual-mode merge-pr pause. Non-empty
	 * text creates a new FeedbackEntry and starts the feedback-implementer step.
	 * The WS handler always routes empty/whitespace input straight to resume()
	 * and never reaches this method with empty text; the empty-text early-return
	 * below exists as a defensive no-op for direct programmatic callers.
	 */
	submitFeedback(workflowId: string, text: string): void {
		const workflow = this.getWorkflowOrThrow(workflowId);
		const trimmed = text.trim();

		if (trimmed === "") {
			this.resume(workflowId);
			return;
		}
		// Handler-side validation in `handleFeedback` is authoritative; these guards
		// are defense-in-depth for programmatic callers. Log on silent drop so a
		// mis-sequencing can be diagnosed from the logs instead of source inspection.
		if (workflow.status !== "paused") {
			logger.warn(
				`[pipeline] submitFeedback rejected for workflow ${workflowId}: workflow status=${workflow.status}, expected paused`,
			);
			return;
		}
		const step = workflow.steps[workflow.currentStepIndex];
		if (step.name !== STEP.MERGE_PR) {
			logger.warn(
				`[pipeline] submitFeedback rejected for workflow ${workflowId}: current step=${step.name}, expected ${STEP.MERGE_PR}`,
			);
			return;
		}
		if (configStore.get().autoMode !== "manual") {
			logger.warn(
				`[pipeline] submitFeedback rejected for workflow ${workflowId}: autoMode is not manual`,
			);
			return;
		}
		if (workflow.feedbackEntries.some((e) => e.outcome === null)) {
			logger.warn(
				`[pipeline] submitFeedback rejected for workflow ${workflowId}: an in-flight feedback entry already exists`,
			);
			return;
		}

		const now = new Date().toISOString();
		const entry: FeedbackEntry = {
			id: randomUUID(),
			iteration: workflow.feedbackEntries.length + 1,
			text: trimmed,
			submittedAt: now,
			submittedAtStepName: STEP.MERGE_PR,
			outcome: null,
		};
		workflow.feedbackEntries.push(entry);
		workflow.updatedAt = now;

		// Reset merge-pr so a clean re-entry is possible after CI re-runs
		this.stepRunner.resetStep(step, "pending");

		// Advance currentStepIndex BEFORE transitioning the workflow to running, so
		// no broadcast ever carries the logically-impossible `{ status: running,
		// currentStep: merge-pr }` combination. startStep emits the single final
		// broadcast once the feedback-implementer step is seeded.
		const fiIndex = this.requireStepIndex(workflow, STEP.FEEDBACK_IMPLEMENTER);
		workflow.currentStepIndex = fiIndex;

		this.engine.transition(workflowId, "running");
		this.startStep(workflow);
	}

	private async runFeedbackImplementer(workflow: Workflow): Promise<void> {
		const latest = workflow.feedbackEntries[workflow.feedbackEntries.length - 1];
		if (!latest || latest.outcome !== null) {
			this.handleStepError(workflow.id, "No in-flight feedback entry to implement");
			return;
		}
		if (!workflow.prUrl) {
			this.handleStepError(workflow.id, "No PR URL — cannot run feedback-implementer");
			return;
		}
		const cwd = requireWorktreePath(workflow);

		// Only snapshot HEAD on the first run. The value is persisted on the
		// workflow so it also survives server restart — commits pushed before a
		// pause/restart are still counted in `commitRefs` when the run resumes.
		if (!workflow.feedbackPreRunHead) {
			workflow.feedbackPreRunHead = await this.getGitHeadFn(cwd);
			this.persistWorkflow(workflow);
		}

		// Race guard: if the user paused (or the workflow otherwise left running)
		// while awaiting git, don't spawn the CLI — the pause already killed any
		// in-flight process and the user's intent is to stop.
		const current = this.getActiveWorkflow(workflow.id);
		const currentStep = current?.steps[current.currentStepIndex];
		if (
			!current ||
			current.status !== "running" ||
			currentStep?.name !== STEP.FEEDBACK_IMPLEMENTER ||
			currentStep.status !== "running"
		) {
			logger.info(
				`[pipeline] Feedback-implementer race guard fired for workflow ${workflow.id}; user paused during pre-run head snapshot`,
			);
			return;
		}

		const config = configStore.get();
		const prompt = buildFeedbackPrompt(config, workflow, latest.text, workflow.prUrl);
		// Feedback-implementer is a substantive main AI step (research R2). Use the
		// same model/effort as the regular implement step so the active-model panel
		// accurately reflects what's running.
		this.runStep(workflow, prompt, cwd, config.models.implement, config.efforts.implement);
	}

	/**
	 * After a feedback-implementer step completes normally: parse its output,
	 * reconcile with git, write the outcome onto the latest entry, and route.
	 */
	private async completeFeedbackImplementer(workflow: Workflow): Promise<void> {
		const cwd = workflow.worktreePath;
		const preRunHead = workflow.feedbackPreRunHead;
		const commits = preRunHead && cwd ? await this.detectNewCommitsFn(preRunHead, cwd) : [];

		const step = workflow.steps[workflow.currentStepIndex];
		const parsed = parseAgentResult(step.output);
		const outcome = reconcileOutcome(parsed, commits, false);

		const latest = workflow.feedbackEntries[workflow.feedbackEntries.length - 1];
		if (latest && latest.outcome === null) {
			latest.outcome = outcome;
		}
		workflow.updatedAt = new Date().toISOString();
		workflow.feedbackPreRunHead = null;

		if (outcome.value === "success") {
			// A user-initiated feedback iteration begins a fresh CI cycle — reset
			// the attempt counters so prior fix-ci / merge retries don't starve
			// the new cycle of attempts.
			workflow.ciCycle.attempt = 0;
			workflow.ciCycle.monitorStartedAt = null;
			workflow.ciCycle.failureLogs = [];
			workflow.mergeCycle.attempt = 0;

			const monitorIdx = this.requireStepIndex(workflow, STEP.MONITOR_CI);
			workflow.currentStepIndex = monitorIdx;
			// Persistence and step reset are handled by startStep.
			this.startStep(workflow);
			return;
		}

		// Agent-reported failed: align FI step status with the entry outcome so
		// the pipeline-step indicator and the outcome badge agree. `no changes`
		// leaves the step at `completed` — the step ran successfully, the agent
		// simply produced nothing to commit.
		if (outcome.value === "failed") {
			step.status = "error";
			step.error = outcome.summary;
			// Stamp completedAt at the moment the outcome was determined, matching
			// handleStepError's FI branch. `advanceAfterStep` set a placeholder
			// milliseconds earlier — overwrite so both error paths carry the same
			// semantic "moment the FI run ended" timestamp.
			step.completedAt = new Date().toISOString();
		}

		// no changes / agent-reported failed → rewind to merge-pr pause.
		this.routeToMergePrPause(workflow);
	}

	/**
	 * Rewind currentStepIndex to merge-pr and re-enter startStep, which will
	 * pause in manual mode (the same state the user was in before submitting).
	 */
	private routeToMergePrPause(workflow: Workflow): void {
		const mergeIdx = this.requireStepIndex(workflow, STEP.MERGE_PR);
		const mergeStep = workflow.steps[mergeIdx];
		this.stepRunner.resetStep(mergeStep, "pending");
		workflow.currentStepIndex = mergeIdx;
		this.persistWorkflow(workflow);
		this.startStep(workflow);
	}

	private startStep(workflow: Workflow): void {
		const step = workflow.steps[workflow.currentStepIndex];
		const previousIndex = workflow.currentStepIndex - 1;
		const previousStep = previousIndex >= 0 ? workflow.steps[previousIndex].name : null;

		this.stepRunner.resetStep(step);
		workflow.updatedAt = new Date().toISOString();

		this.resetStepState();

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

		if (step.name === STEP.FEEDBACK_IMPLEMENTER) {
			this.runFeedbackImplementer(workflow).catch((err) => {
				this.handleStepError(workflow.id, toErrorMessage(err));
			});
			return;
		}

		if (step.name === STEP.MERGE_PR) {
			if (shouldPauseBeforeMerge(configStore.get().autoMode)) {
				const prInfo = workflow.prUrl ? ` — review PR: ${workflow.prUrl}` : "";
				this.handleStepOutput(
					workflow.id,
					`[manual mode] CI passed — review and merge PR, then resume${prInfo}`,
				);
				step.status = "paused";
				workflow.updatedAt = new Date().toISOString();
				this.engine.transition(workflow.id, "paused");
				this.persistWorkflow(workflow);
				this.callbacks.onStateChange(workflow.id);
				return;
			}
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

		if (step.name === STEP.COMMIT_PUSH_PR) {
			this.ensureBranchBeforeCommitPushPr(workflow, cwd)
				.then(() => {
					this.runStep(
						workflow,
						step.prompt,
						cwd,
						configKey ? config.models[configKey] : undefined,
						configKey ? config.efforts[configKey] : undefined,
					);
				})
				.catch((err) => {
					this.handleStepError(workflow.id, toErrorMessage(err));
				});
			return;
		}

		this.runStep(
			workflow,
			step.prompt,
			cwd,
			configKey ? config.models[configKey] : undefined,
			configKey ? config.efforts[configKey] : undefined,
		);
	}

	/**
	 * Safety net: if the worktree is on detached HEAD when commit-push-pr starts,
	 * switch to (or create) the feature branch. Only acts when detached — logged
	 * to both server logger and client step output so the fallback is visible.
	 */
	private async ensureBranchBeforeCommitPushPr(workflow: Workflow, cwd: string): Promise<void> {
		const branch = await this.getBranch(cwd);
		// null → git query failed (missing dir / unavailable git); leave state alone
		// anything other than "HEAD" → already on a branch, nothing to do
		if (branch !== "HEAD") return;

		const targetBranch = workflow.featureBranch ?? workflow.worktreeBranch;
		if (!targetBranch) {
			throw new Error(
				"Worktree is on detached HEAD and no feature branch name is available to recover",
			);
		}

		const warnMsg = `[safety] Worktree on detached HEAD — switching to branch '${targetBranch}' before creating PR`;
		logger.warn(`[pipeline] ${warnMsg}`);
		this.handleStepOutput(workflow.id, warnMsg);

		const switchExisting = await gitSpawn(["git", "switch", targetBranch], { cwd });
		if (switchExisting.code === 0) {
			const okMsg = `[safety] Switched to existing branch '${targetBranch}'`;
			logger.info(`[pipeline] ${okMsg}`);
			this.handleStepOutput(workflow.id, okMsg);
			return;
		}

		const createBranch = await gitSpawn(["git", "switch", "-c", targetBranch], { cwd });
		if (createBranch.code === 0) {
			const okMsg = `[safety] Created branch '${targetBranch}' from detached HEAD`;
			logger.info(`[pipeline] ${okMsg}`);
			this.handleStepOutput(workflow.id, okMsg);
			return;
		}

		throw new Error(
			`Failed to recover from detached HEAD: could not switch to or create branch '${targetBranch}': ${createBranch.stderr || `exit ${createBranch.code}`}`,
		);
	}

	private runSetup(workflow: Workflow): void {
		const targetDir = requireTargetRepository(workflow);

		this.runSetupChecksFn(targetDir)
			.then((result) => {
				const wf = this.getActiveWorkflow(workflow.id);
				if (!wf) return;

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

				// All checks passed — create worktree, then checkout latest master
				this.createWorktreeAndCheckout(wf);
			})
			.catch((err) => {
				this.handleStepError(workflow.id, `Setup checks failed: ${toErrorMessage(err)}`);
			});
	}

	private createWorktreeAndCheckout(workflow: Workflow): void {
		const targetDir = requireTargetRepository(workflow);
		const shortId = workflow.worktreeBranch.replace("tmp-", "");

		this.engine
			.createWorktree(shortId, targetDir)
			.then(async (worktreePath) => {
				const wf = this.getActiveWorkflow(workflow.id);
				if (!wf) return;

				wf.worktreePath = worktreePath;
				try {
					await this.engine.copyGitignoredFiles(targetDir, worktreePath);
				} catch (copyErr) {
					// Clean up the worktree that was already created on disk
					try {
						await this.engine.removeWorktree(worktreePath, targetDir);
					} catch {
						// Best-effort cleanup
					}
					wf.worktreePath = null;
					throw copyErr;
				}
				this.persistWorkflow(wf);
				this.checkoutMasterInWorktree(wf);
			})
			.catch((err) => {
				this.handleStepError(workflow.id, `Failed to create git worktree: ${toErrorMessage(err)}`);
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
				const wf = this.getActiveWorkflow(workflow.id);
				if (!wf) return;

				if (result.code !== 0) {
					const errMsg = result.stderr || `exit code ${result.code}`;
					this.handleStepError(wf.id, `Failed to checkout master in worktree: ${errMsg}`);
					return;
				}
				this.handleStepOutput(wf.id, "✓ Checked out latest master in worktree");
				this.initSpeckitInWorktree(wf);
			})
			.catch((err) => {
				this.handleStepError(
					workflow.id,
					`Failed to checkout master in worktree: ${toErrorMessage(err)}`,
				);
			});
	}

	private initSpeckitInWorktree(workflow: Workflow): void {
		const cwd = requireWorktreePath(workflow);
		this.handleStepOutput(workflow.id, "[speckit] Ensuring spec-kit skills in worktree");

		this.ensureSpeckitSkillsFn(cwd)
			.then(({ installed, initResult }) => {
				const wf = this.getActiveWorkflow(workflow.id);
				if (!wf) return;

				if (!installed) {
					const errMsg = initResult?.stderr || `exit code ${initResult?.code}`;
					this.handleStepError(wf.id, `Failed to initialize spec-kit: ${errMsg}`);
					return;
				}

				if (initResult) {
					this.handleStepOutput(wf.id, "✓ Spec-kit initialized via uvx");
				} else {
					this.handleStepOutput(wf.id, "✓ Spec-kit skills already present");
				}
				this.advanceAfterStep(wf.id);
			})
			.catch((err) => {
				this.handleStepError(workflow.id, `Failed to initialize spec-kit: ${toErrorMessage(err)}`);
			});
	}

	private runMonitorCi(workflow: Workflow): void {
		if (!workflow.prUrl) {
			// Try to discover PR URL from branch
			this.ciMonitor
				.discoverPrUrl(workflow)
				.then((url) => {
					// The user may have paused while discoverPrUrl awaited. Without this
					// guard we would start a fresh CI polling session whose AbortController
					// the prior pause() cannot reach.
					const current = this.getActiveWorkflow(workflow.id);
					if (!current || current.status !== "running") {
						logger.info(
							`[pipeline] discoverPrUrl continuation skipped for workflow ${workflow.id}: status=${current?.status ?? "missing"}`,
						);
						return;
					}
					if (!url) {
						this.handleStepError(workflow.id, "No PR URL found — cannot monitor CI checks");
						return;
					}
					current.prUrl = url;
					this.persistWorkflow(current);
					this.startCiMonitoring(current);
				})
				.catch((err) => {
					this.handleStepError(workflow.id, `Failed to discover PR URL: ${toErrorMessage(err)}`);
				});
			return;
		}

		this.startCiMonitoring(workflow);
	}

	private startCiMonitoring(workflow: Workflow): void {
		workflow.ciCycle.monitorStartedAt =
			workflow.ciCycle.monitorStartedAt ?? new Date().toISOString();
		this.persistWorkflow(workflow);

		this.ciMonitor
			.startMonitoring(workflow, (msg) => this.handleStepOutput(workflow.id, msg))
			.then((result) => this.handleMonitorResult(workflow.id, result))
			.catch((err) => {
				this.handleStepError(workflow.id, `CI monitoring failed: ${toErrorMessage(err)}`);
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
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow) return;

		// If workflow was paused/cancelled while monitoring, ignore the result
		if (workflow.status !== "running") return;

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
				this.handleStepError(
					workflow.id,
					`Failed to gather CI failure logs: ${toErrorMessage(err)}`,
				);
			});
	}

	private advanceToFixCi(workflow: Workflow): void {
		const step = workflow.steps[workflow.currentStepIndex];
		step.status = "completed";
		step.completedAt = new Date().toISOString();
		step.pid = null;
		workflow.updatedAt = new Date().toISOString();
		this.flushPersistDebounce();
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
		// Inject accumulated user feedback as authoritative context into every
		// CLI-spawned step (FR-010). Skip for feedback-implementer, whose prompt
		// template already interpolates ${feedbackContext} directly.
		const step = workflow.steps[workflow.currentStepIndex];
		let finalPrompt = prompt;
		if (step?.name !== STEP.FEEDBACK_IMPLEMENTER) {
			const feedbackCtx = buildFeedbackContext(workflow);
			if (feedbackCtx) {
				finalPrompt = `${feedbackCtx}\n\n---\n\n${prompt}`;
			}
		}
		const stepWorkflow: Workflow = {
			...workflow,
			specification: finalPrompt,
			worktreePath: cwd,
		};

		// Set activeInvocation whenever the caller intends an AI-driven step
		// (model param provided, even if empty — empty means "Claude Code default").
		// Steps like SETUP / MERGE_PR / SYNC_REPO pass model === undefined and
		// correctly don't populate the panel.
		if (step && model !== undefined) {
			workflow.activeInvocation = {
				model,
				effort: effort ?? null,
				stepName: step.name,
				startedAt: new Date().toISOString(),
				role: "main",
			};
			workflow.updatedAt = new Date().toISOString();
			this.persistWorkflow(workflow);
			this.callbacks.onStateChange(workflow.id);
		}

		this.stepRunner.startStep(
			stepWorkflow,
			this.buildStepCallbacks(workflow.id),
			this.buildStepEnv(workflow),
			model,
			effort,
		);
	}

	private handleStepOutput(workflowId: string, text: string): void {
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow) return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.output += `${text}\n`;
		enforceStepOutputCap(step, this.maxStepOutputChars);
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
				if (e instanceof Error && !e.message.includes("not found")) {
					logger.warn("[pipeline] Step summary update failed:", e);
					throw e;
				}
			}
		});
	}

	private handleStepComplete(workflowId: string): void {
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow) return;

		// Clear + broadcast immediately so the panel can't lag behind an async
		// question-classifier (Haiku) or a downstream startStep. SC-002 requires
		// the panel to reflect reality within 1s; the Haiku round-trip can exceed
		// that, so we fire onStateChange here rather than waiting for the next
		// branch to broadcast.
		workflow.activeInvocation = null;
		this.callbacks.onStateChange(workflowId);

		const step = workflow.steps[workflow.currentStepIndex];

		// Guard: CLI step completed with no output — process likely exited
		// before actually running (e.g. Windows .cmd wrapper, spawn failure).
		if (!step.output.trim()) {
			this.handleStepError(
				workflowId,
				`CLI process exited successfully but produced no output — step "${step.name}" cannot advance without results`,
			);
			return;
		}

		// Feedback-implementer is a non-interactive step: its output is parsed
		// from a sentinel block and routed by completeFeedbackImplementer. Skip
		// the question classifier so an agent emitting question-shaped text
		// (or a Haiku misclassification) can't strand the workflow in
		// waiting_for_input and silently block every subsequent feedback
		// submission via the FR-016 in-flight guard.
		if (step.name === STEP.FEEDBACK_IMPLEMENTER) {
			this.advanceAfterStep(workflowId);
			return;
		}

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
					logger.warn(`[pipeline] Haiku classification failed, advancing: ${err}`);
					this.advanceAfterStep(workflowId);
				});
		} else {
			this.advanceAfterStep(workflowId);
		}
	}

	private pauseForQuestion(workflowId: string, question: Question): void {
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow || workflow.status !== "running") return;

		// Full-auto mode: answer immediately instead of pausing
		if (shouldAutoAnswer(configStore.get().autoMode)) {
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
		this.tryTransition(workflowId, "waiting_for_input");

		this.flushPersistDebounce();
		this.persistWorkflow(workflow);
		this.callbacks.onStateChange(workflowId);

		const summary = question.content.slice(0, 200);
		this.emitAlert(
			"question-asked",
			workflow,
			"Question awaiting answer",
			`${workflow.summary || workflow.specification.slice(0, 60)} — ${summary}`,
		);
	}

	private advanceAfterStep(workflowId: string): void {
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow) return;

		// An async callback (classifyWithHaiku in handleStepComplete, gatherAllFailureLogs,
		// resolveConflicts, syncRepo, etc.) can resolve after the user has paused or
		// cancelled the workflow. Advancing in that case would silently start the next
		// step and override the user's intent to stop.
		if (workflow.status !== "running") {
			logger.info(
				`[pipeline] advanceAfterStep skipped for workflow ${workflowId}: status=${workflow.status}`,
			);
			return;
		}

		const step = workflow.steps[workflow.currentStepIndex];
		step.status = "completed";
		step.completedAt = new Date().toISOString();
		step.pid = null;
		workflow.updatedAt = new Date().toISOString();

		// Reset activity buffer between steps so the next step starts fresh
		this.summarizer.resetBuffer(workflowId);

		if (step.name === STEP.FEEDBACK_IMPLEMENTER) {
			this.completeFeedbackImplementer(workflow).catch((err) => {
				this.handleStepError(workflowId, `Feedback routing failed: ${toErrorMessage(err)}`);
			});
			return;
		}

		if (step.name === STEP.COMMIT_PUSH_PR) {
			const url = extractPrUrl(step.output);
			if (url) {
				const firstPr = !workflow.prUrl;
				workflow.prUrl = url;
				if (firstPr && configStore.get().autoMode === "manual") {
					this.emitAlert(
						"pr-opened-manual",
						workflow,
						"PR opened — ready to review",
						`${workflow.summary || workflow.specification.slice(0, 80)} — ${url}`,
					);
				}
			}
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
		// Snapshot artifacts now that branch detection/worktree rename have
		// settled, so getSpecsRoot() points at the correct path.
		const completedStep = workflow.steps[workflow.currentStepIndex];
		if (completedStep) {
			try {
				snapshotStepArtifacts(workflow, completedStep.name);
			} catch (err) {
				logger.warn(
					`[pipeline] Failed to snapshot artifacts for ${completedStep.name}: ${String(err)}`,
				);
			}
		}

		this.flushPersistDebounce();
		this.persistWorkflow(workflow);

		try {
			const decision = computeRoute(workflow);

			switch (decision.action) {
				case "route-to-monitor-ci": {
					workflow.currentStepIndex = this.requireStepIndex(workflow, STEP.MONITOR_CI);
					this.startStep(workflow);
					return;
				}
				case "route-to-merge-pr": {
					workflow.currentStepIndex = this.requireStepIndex(workflow, STEP.MERGE_PR);
					this.startStep(workflow);
					return;
				}
				case "route-back-to-monitor":
					this.routeBackToMonitor(workflow);
					return;
				case "route-to-sync-repo": {
					workflow.currentStepIndex = this.requireStepIndex(workflow, STEP.SYNC_REPO);
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
						const msg = toErrorMessage(err);
						logger.error(`[pipeline] Implement-review completion error: ${msg}`);
						this.handleStepError(workflow.id, msg);
					});
					return;
				case "advance-to-next":
					this.advanceToNextStep(workflow);
					return;
			}
		} catch (err) {
			this.handleStepError(workflow.id, `Routing failed: ${toErrorMessage(err)}`);
		}
	}

	private routeToImplementReview(workflow: Workflow): void {
		workflow.reviewCycle.iteration++;

		const implReviewIndex = this.requireStepIndex(workflow, STEP.IMPLEMENT_REVIEW);

		// Reset implement-review step for re-use
		const implStep = workflow.steps[implReviewIndex];
		this.stepRunner.resetStep(implStep, "pending");

		workflow.currentStepIndex = implReviewIndex;
		this.persistWorkflow(workflow);
		this.startStep(workflow);
	}

	private async handleImplementReviewComplete(workflow: Workflow): Promise<void> {
		// Classify the review step's output to decide whether to loop
		const reviewIndex = this.requireStepIndex(workflow, STEP.REVIEW);
		const reviewStep = workflow.steps[reviewIndex];
		const severity = await this.reviewClassifier.classify(reviewStep.output);

		workflow.reviewCycle.lastSeverity = severity;
		workflow.updatedAt = new Date().toISOString();

		if (
			shouldLoopReview(severity, workflow.reviewCycle.iteration, workflow.reviewCycle.maxIterations)
		) {
			// Reset review step and loop back
			const step = workflow.steps[reviewIndex];
			this.stepRunner.resetStep(step, "pending");

			workflow.currentStepIndex = reviewIndex;
			this.persistWorkflow(workflow);
			this.startStep(workflow);
		} else {
			workflow.currentStepIndex = this.requireStepIndex(workflow, STEP.COMMIT_PUSH_PR);
			this.startStep(workflow);
		}
	}

	/**
	 * Handle the case where `resolveConflicts` reported that the local tree
	 * already contained origin/master but `gh pr merge` had still reported a
	 * conflict. Typically this is stale GitHub mergeability state: retry the
	 * merge exactly once without consuming a `mergeCycle.attempt`, and surface
	 * a diagnostic error if it still reports a conflict.
	 */
	private retryMergeAfterAlreadyUpToDate(workflow: Workflow): void {
		if (!workflow.prUrl) {
			this.handleStepError(workflow.id, "No PR URL found — cannot retry merge");
			return;
		}
		const cwd = requireWorktreePath(workflow);
		this.handleStepOutput(
			workflow.id,
			"Local tree already up-to-date with master, but GitHub reported a conflict. Retrying merge in case mergeability state was stale.",
		);
		this.mergePrFn(workflow.prUrl, cwd, (msg) => this.handleStepOutput(workflow.id, msg))
			.then((retryResult) => {
				const latest = this.getActiveWorkflow(workflow.id);
				if (!latest || latest.status !== "running") return;
				if (retryResult.merged || retryResult.alreadyMerged) {
					this.advanceAfterStep(workflow.id);
					return;
				}
				if (retryResult.conflict) {
					this.handleStepError(
						workflow.id,
						"GitHub continues to report a merge conflict even though the local branch already contains origin/master. Resolve the PR manually or investigate squash-merge path-level conflicts.",
					);
					return;
				}
				this.handleStepError(workflow.id, retryResult.error || "PR merge retry failed");
			})
			.catch((err) => {
				this.handleStepError(workflow.id, `PR merge retry failed: ${toErrorMessage(err)}`);
			});
	}

	private routeBackToMonitor(workflow: Workflow): void {
		workflow.ciCycle.attempt++;
		workflow.ciCycle.monitorStartedAt = null;
		workflow.ciCycle.failureLogs = [];

		const monitorIndex = this.requireStepIndex(workflow, STEP.MONITOR_CI);
		const monitorStep = workflow.steps[monitorIndex];
		this.stepRunner.resetStep(monitorStep, "pending");

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
				this.handleStepError(workflow.id, `PR merge failed: ${toErrorMessage(err)}`);
			});
	}

	private handleMergeResult(workflowId: string, result: import("./types").MergeResult): void {
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow) return;

		// If the user paused/cancelled while mergePr was in-flight, do not advance
		// or route back to monitor-ci. Otherwise the async merge completion would
		// silently restart the pipeline behind a paused workflow status.
		if (workflow.status !== "running") {
			logger.info(
				`[pipeline] handleMergeResult skipped for workflow ${workflowId}: status=${workflow.status}`,
			);
			return;
		}

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
					`Merge conflicts persist after ${workflow.mergeCycle.attempt} resolution attempts. Resolve the conflict manually or retry with ${workflow.mergeCycle.maxAttempts} more attempts.`,
				);
				return;
			}

			// Resolve conflicts and loop back to monitor-ci
			const cwd = requireWorktreePath(workflow);
			this.resolveConflictsFn(cwd, workflow.summary || workflow.specification, (msg) =>
				this.handleStepOutput(workflow.id, msg),
			)
				.then((resolution) => {
					// Re-check status: the user may have paused while conflict resolution ran.
					// Without this guard, routeBackToMonitor would start a fresh CI polling
					// session with a new AbortController that pause() cannot reach.
					const current = this.getActiveWorkflow(workflowId);
					if (!current || current.status !== "running") {
						logger.info(
							`[pipeline] conflict-resolution continuation skipped for workflow ${workflowId}: status=${current?.status ?? "missing"}`,
						);
						return;
					}
					if (resolution?.kind === "already-up-to-date") {
						this.retryMergeAfterAlreadyUpToDate(current);
						return;
					}
					current.mergeCycle.attempt++;
					this.routeBackToMonitor(current);
				})
				.catch((err) => {
					this.handleStepError(workflowId, `Conflict resolution failed: ${toErrorMessage(err)}`);
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
				// Even on error, sync-repo completes (PR is already merged)
				const msg = toErrorMessage(err);
				this.handleStepOutput(workflow.id, `Warning: sync failed: ${msg}`);
				this.advanceAfterStep(workflow.id);
			});
	}

	/**
	 * Release the managed clone's refcount (if this workflow was cloned from a URL).
	 * Idempotent: clears `workflow.managedRepo` after release so retry-then-error
	 * paths (error → running → error) and any other double-entry into a terminal
	 * handler cannot double-release. Also keeps restart-time `seedFromWorkflows`
	 * self-consistent — a workflow whose refcount has already been released will
	 * not be re-counted if it somehow survives as a non-terminal record on disk.
	 *
	 * INVARIANT — caller contract: the workflow MUST have already been transitioned
	 * to a terminal state (completed/cancelled/error) AND that state MUST have
	 * been persisted before this method is invoked. Both `persistWorkflow` here
	 * and `managedRepoStore.release` are fire-and-forget; the ordering that makes
	 * this safe is: terminal-state-save happens in the caller → this method's
	 * two async operations fire → a crash between them leaves a terminal record
	 * on disk (which `seedFromWorkflows` filters out). Move the release earlier
	 * in the lifecycle only if you also move the terminal persist earlier.
	 */
	private releaseManagedRepoIfAny(workflow: Workflow): void {
		if (!workflow.managedRepo || !this.managedRepoStore) return;
		const { owner, repo } = workflow.managedRepo;
		workflow.managedRepo = null;
		this.persistWorkflow(workflow);
		this.managedRepoStore.release(owner, repo).catch((err) => {
			logger.warn(
				`[pipeline] managed-repo release failed for ${owner}/${repo}: ${toErrorMessage(err)}`,
			);
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
		this.tryTransition(workflow.id, "completed");
		this.stepRunner.killProcess(workflow.id);
		this.summarizer.cleanup(workflow.id);
		this.persistWorkflow(workflow);
		this.callbacks.onComplete(workflow.id);
		this.callbacks.onStateChange(workflow.id);

		// For URL-sourced workflows, the sync-repo step has already removed the worktree.
		// Release the managed-repo refcount so the clone is cleaned up when the last
		// consumer finishes.
		this.releaseManagedRepoIfAny(workflow);

		if (!workflow.epicId) {
			this.emitAlert(
				"workflow-finished",
				workflow,
				"Workflow finished",
				workflow.summary || workflow.specification.slice(0, 120),
			);
		}

		// Check epic dependencies — notify server to resolve dependent workflows
		// and emit `epic-finished` when every sibling has reached a terminal state.
		if (workflow.epicId) {
			this.checkEpicDependencies(workflow).catch((err) => {
				logger.error(`[pipeline] Failed to check epic dependencies: ${err}`);
			});
		}
	}

	private async checkEpicDependencies(triggerWorkflow: Workflow): Promise<void> {
		if (!triggerWorkflow.epicId) return;

		// Wait for in-flight saves (trigger's own persist, and any sibling whose
		// completeWorkflow/handleStepError queued a save before this call) to
		// settle. Otherwise loadAll can read a sibling as still "running" and we
		// miss the `epic-finished` alert on simultaneous sibling completion.
		await this.store.waitForPendingWrites();
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

		// Emit `epic-finished` when every workflow in the epic has reached a
		// terminal state. Dedup on (type, epicId) in AlertQueue guarantees at-most-once.
		const epicWorkflows = allWorkflows.filter((w) => w.epicId === triggerWorkflow.epicId);
		const terminal = (s: WorkflowStatus) => s === "completed" || s === "error" || s === "cancelled";
		const allTerminal =
			epicWorkflows.length > 0 &&
			epicWorkflows.every((w) => w.id === triggerWorkflow.id || terminal(w.status));
		if (allTerminal) {
			this.callbacks.onAlertEmit?.({
				type: "epic-finished",
				title: "Epic finished",
				description: triggerWorkflow.epicTitle || "Epic completed",
				workflowId: null,
				epicId: triggerWorkflow.epicId,
				targetRoute: `/epic/${triggerWorkflow.epicId}`,
			});
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
				logger.info(`[pipeline] Detected feature branch: ${best}`);
			}
		} catch (err) {
			logger.warn("[pipeline] Failed to scan specs/ directory:", err);
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
			logger.info(`[pipeline] Renamed worktree to ${newRelativePath}`);
		} catch (err) {
			logger.warn(`[pipeline] Worktree rename failed (non-fatal): ${toErrorMessage(err)}`);
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
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow) return;

		workflow.activeInvocation = null;
		this.callbacks.onStateChange(workflowId);

		const step = workflow.steps[workflow.currentStepIndex];

		// Feedback-implementer pre-commit failure: record failed outcome and rewind
		// to merge-pr pause. Do NOT transition the workflow to error state.
		if (step.name === STEP.FEEDBACK_IMPLEMENTER) {
			this.summarizer.cleanup(workflowId);
			const latest = workflow.feedbackEntries[workflow.feedbackEntries.length - 1];
			if (latest && latest.outcome === null) {
				latest.outcome = {
					value: "failed",
					summary: error,
					commitRefs: [],
					warnings: [],
				};
			}
			step.status = "error";
			step.error = error;
			step.completedAt = new Date().toISOString();
			step.pid = null;
			workflow.feedbackPreRunHead = null;
			workflow.updatedAt = new Date().toISOString();
			this.callbacks.onError(workflowId, error);
			this.routeToMergePrPause(workflow);
			return;
		}

		this.summarizer.cleanup(workflowId);

		if (this.currentAuditRunId) {
			this.auditLogger.endRun(this.currentAuditRunId, { error });
			this.currentAuditRunId = null;
		}

		step.status = "error";
		step.error = error;
		step.pid = null;
		workflow.updatedAt = new Date().toISOString();

		this.tryTransition(workflowId, "error");

		// Drop any outstanding question-asked alert: the workflow is terminal
		// and the question panel is hidden, so a lingering alert would navigate
		// the user to a dead-end (FR-013 parity for the error path).
		this.engine.clearQuestion(workflowId);
		this.clearQuestionAlert(workflowId);

		this.flushPersistDebounce();
		this.persistWorkflow(workflow);
		this.callbacks.onError(workflowId, error);
		this.callbacks.onStateChange(workflowId);

		// Release managed-repo refcount on errored workflows so the clone is
		// eventually cleaned up. data-model.md §"Clone Consumer" lists errored
		// alongside completed/cancelled as a terminal state that must release.
		this.releaseManagedRepoIfAny(workflow);

		const shortError = error.length > 200 ? `${error.slice(0, 197)}...` : error;
		this.emitAlert(
			"error",
			workflow,
			"Workflow error",
			`${workflow.summary || workflow.specification.slice(0, 60)} — ${shortError}`,
		);

		// Update epic dependency status for siblings if this workflow errored
		if (workflow.epicId) {
			this.checkEpicDependencies(workflow).catch((err) => {
				logger.error(`[pipeline] Failed to check epic dependencies: ${err}`);
			});
		}
	}

	private handlePid(workflowId: string, pid: number): void {
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow) return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.pid = pid;
		this.persistWorkflow(workflow);
	}

	private handleSessionId(workflowId: string, sessionId: string): void {
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow) return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.sessionId = sessionId;
		this.persistWorkflow(workflow);
	}

	private emitAlert(type: AlertType, workflow: Workflow, title: string, description: string): void {
		if (!this.callbacks.onAlertEmit) return;
		// Always route to the specific workflow — the client's workflow-route
		// handler drills into the epic and auto-selects the child, so
		// `/workflow/<id>` gives one-click navigation whether or not the
		// workflow belongs to an epic.
		this.callbacks.onAlertEmit({
			type,
			title,
			description,
			workflowId: workflow.id,
			epicId: workflow.epicId,
			targetRoute: `/workflow/${workflow.id}`,
		});
	}

	private clearQuestionAlert(workflowId: string): void {
		this.callbacks.onAlertDismissWhere?.({ type: "question-asked", workflowId });
	}

	private persistWorkflow(workflow: Workflow): void {
		this.store.save(workflow).catch((err) => {
			logger.error(`[pipeline] Failed to persist workflow: ${err}`);
		});
	}

	/** Reset assistant text buffer and question detector state between steps. */
	private resetStepState(): void {
		this.assistantTextBuffer = "";
		this.questionDetector.reset();
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

	private flushPersistDebounce(): void {
		if (this.persistDebounceTimer) {
			clearTimeout(this.persistDebounceTimer);
			this.persistDebounceTimer = null;
		}
	}

	getStore(): WorkflowStore {
		return this.store;
	}

	private buildStepCallbacks(workflowId: string): CLICallbacks {
		return this.stepRunner.buildCallbacks(workflowId, {
			onOutput: (wfId, text) => this.handleStepOutput(wfId, text),
			onComplete: (wfId) => this.handleStepComplete(wfId),
			onError: (wfId, error) => this.handleStepError(wfId, error),
			onSessionId: (wfId, sessionId) => this.handleSessionId(wfId, sessionId),
			onPid: (wfId, pid) => this.handlePid(wfId, pid),
			onTools: (tools) => this.callbacks.onTools(workflowId, tools),
		});
	}

	private requireStepIndex(workflow: Workflow, stepName: PipelineStepName): number {
		const index = workflow.steps.findIndex((s) => s.name === stepName);
		if (index < 0) {
			throw new Error(`Step "${stepName}" not found in workflow ${workflow.id}`);
		}
		return index;
	}

	/** Attempt a status transition, silently ignoring "Invalid transition" errors. */
	private tryTransition(workflowId: string, status: WorkflowStatus): void {
		try {
			this.engine.transition(workflowId, status);
		} catch (e) {
			if (e instanceof Error && !e.message.includes("Invalid transition")) throw e;
			else logger.warn(`[pipeline] Suppressed transition error: ${e}`);
		}
	}

	/** Get the active workflow if it matches the given ID, or null. */
	private getActiveWorkflow(workflowId: string): Workflow | null {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return null;
		return workflow;
	}

	private getWorkflowOrThrow(workflowId: string): Workflow {
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow) {
			throw new Error(`Workflow ${workflowId} not found`);
		}
		return workflow;
	}
}
