import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildArtifactsPrompt } from "./artifacts-prompt";
import { AuditLogger } from "./audit-logger";
import { type CiFlowOutcome, CiMergeFlowController } from "./ci-merge-flow-controller";
import { startMonitoring } from "./ci-monitor";
import { CIMonitorCoordinator } from "./ci-monitor-coordinator";
import { type ClaudeMdGuardResult, guardClaudeMd as defaultGuardClaudeMd } from "./claude-md-guard";
import {
	type AppendResult,
	appendProjectClaudeMd as defaultAppendProjectClaudeMd,
	markClaudeMdSkipWorktree as defaultMarkClaudeMdSkipWorktree,
	type SkipWorktreeResult,
} from "./claude-md-merger";
import type { CLICallbacks } from "./cli-runner";
import { CLIRunner } from "./cli-runner";
import { CLIStepRunner, prepareLlmDispatch } from "./cli-step-runner";
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
import {
	buildFixImplementPrompt,
	classifyFixImplementDiff,
	FIX_IMPLEMENT_EMPTY_DIFF_MESSAGE,
	FIX_IMPLEMENT_HEAD_READ_FAILED_MESSAGE,
} from "./fix-implementer";
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
	type OutputEntry,
	type PipelineCallbacks,
	type PipelineStep,
	type PipelineStepName,
	type Question,
	type SetupResult,
	STEP,
	shouldAutoAnswer,
	shouldPauseBeforeMerge,
	type ToolUsage,
	type Workflow,
	type WorkflowStatus,
} from "./types";
import {
	type ArtifactsCollectionResult,
	collectArtifactsFromManifest,
	getWorkflowBranch,
	snapshotStepArtifacts,
} from "./workflow-artifacts";
import { runInWorkflowContext } from "./workflow-context";
import { nextFixBranchName, WorkflowEngine } from "./workflow-engine";
import { requireTargetRepository, requireWorktreePath } from "./workflow-paths";
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
	[STEP.ARTIFACTS]: "artifacts",
	[STEP.COMMIT_PUSH_PR]: "commitPushPr",
};

// Per-workflow state for the artifacts step's wall-clock timeout enforcement.
// The CLI runner has only an idle timer; the artifacts step spec requires a
// separate wall-clock budget (FR-016, SC-007).
interface ArtifactsStepState {
	timeoutHandle: ReturnType<typeof setTimeout>;
	timedOut: boolean;
	outputDir: string;
	perFileMaxBytes: number;
	perStepMaxBytes: number;
}

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
	appendProjectClaudeMd?: (specWorktree: string) => Promise<AppendResult>;
	markClaudeMdSkipWorktree?: (specWorktree: string) => Promise<SkipWorktreeResult>;
	checkoutMaster?: (cwd: string) => Promise<{ code: number; stderr: string }>;
	/** Returns the git HEAD SHA at the worktree, or null on failure. Overridable in tests. */
	getGitHead?: (cwd: string) => Promise<string | null>;
	/** Returns new commit SHAs in `preRunHead..HEAD` order. Overridable in tests. */
	detectNewCommits?: (preRunHead: string, cwd: string) => Promise<string[]>;
	/** Override per-step output cap (default `MAX_STEP_OUTPUT_CHARS`). Test-only. */
	maxStepOutputChars?: number;
	/** Pre-push CLAUDE.md guard. Overridable in tests. */
	guardClaudeMd?: (cwd: string) => Promise<ClaudeMdGuardResult>;
	/** `git push -u origin <branch>`. Overridable in tests. */
	gitPushFeatureBranch?: (cwd: string, branch: string) => Promise<{ code: number; stderr: string }>;
	/** `gh pr create --fill`. Overridable in tests. */
	ghPrCreate?: (cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
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
	step: Pick<PipelineStep, "history" | "output" | "outputLog">,
	cap: number = MAX_STEP_OUTPUT_CHARS,
): void {
	let historyLen = step.history.reduce((n, h) => n + h.output.length, 0);
	while (step.history.length > 0 && historyLen + step.output.length > cap) {
		const dropped = step.history.shift();
		if (dropped) historyLen -= dropped.output.length;
	}
	if (step.output.length > cap) {
		step.output = step.output.slice(step.output.length - cap);
		// Trim oldest text entries from outputLog until remaining text fits the cap.
		// Tool entries are kept regardless — they are tiny and carry the icon metadata.
		let textLen = 0;
		for (const entry of step.outputLog) {
			if (entry.kind === "text") textLen += entry.text.length;
		}
		while (textLen > cap) {
			const idx = step.outputLog.findIndex((e) => e.kind === "text");
			if (idx < 0) break;
			const dropped = step.outputLog[idx];
			if (dropped.kind === "text") textLen -= dropped.text.length;
			step.outputLog.splice(idx, 1);
		}
	}
}

export function extractPrUrl(output: string): string | null {
	const matches = output.match(PR_URL_PATTERN);
	return matches ? matches[matches.length - 1] : null;
}

function findAskUserQuestion(outputLog: OutputEntry[]): string | null {
	for (let i = outputLog.length - 1; i >= 0; i--) {
		const entry = outputLog[i];
		if (entry.kind !== "tools") continue;
		for (const tool of entry.tools) {
			if (tool.name !== "AskUserQuestion") continue;
			const raw = tool.input?.question;
			if (typeof raw === "string" && raw.trim()) return raw;
		}
	}
	return null;
}

export class PipelineOrchestrator {
	private engine: WorkflowEngine;
	private cliRunner: CLIRunner;
	private stepRunner: CLIStepRunner;
	private ciMonitor: CIMonitorCoordinator;
	// Initialized after this.ciMonitor in the constructor — discoverPrUrlFn
	// captures `this.ciMergeFlow` lazily, so the field is `!`-asserted because
	// the binding happens before the controller is constructed. Safe because no
	// caller invokes the captured fn synchronously during construction.
	private ciMergeFlow!: CiMergeFlowController;
	private questionDetector: QuestionDetector;
	private reviewClassifier: ReviewClassifier;
	private summarizer: Summarizer;
	private auditLogger: AuditLogger;
	private store: WorkflowStore;
	private managedRepoStore: ManagedRepoStore | null;
	private callbacks: PipelineCallbacks;
	private currentAuditRunId: string | null = null;
	private pipelineName: string | null = null;
	private persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private runSetupChecksFn: (targetDir: string) => Promise<SetupResult>;
	private ensureSpeckitSkillsFn: typeof defaultEnsureSpeckitSkills;
	private appendProjectClaudeMdFn: (specWorktree: string) => Promise<AppendResult>;
	private markClaudeMdSkipWorktreeFn: (specWorktree: string) => Promise<SkipWorktreeResult>;
	private checkoutMasterFn: (cwd: string) => Promise<{ code: number; stderr: string }>;
	private getGitHeadFn: (cwd: string) => Promise<string | null>;
	private detectNewCommitsFn: (preRunHead: string, cwd: string) => Promise<string[]>;
	private guardClaudeMdFn: (cwd: string) => Promise<ClaudeMdGuardResult>;
	private gitPushFeatureBranchFn: (
		cwd: string,
		branch: string,
	) => Promise<{ code: number; stderr: string }>;
	private ghPrCreateFn: (cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
	private maxStepOutputChars: number;
	private artifactsState: Map<string, ArtifactsStepState> = new Map();

	constructor(callbacks: PipelineCallbacks, deps?: PipelineDeps) {
		this.engine = deps?.engine ?? new WorkflowEngine();
		this.cliRunner = deps?.cliRunner ?? new CLIRunner();
		this.stepRunner = new CLIStepRunner(this.cliRunner);
		const discoverPrUrlFn =
			deps?.discoverPrUrl ?? ((w: Workflow) => this.ciMergeFlow.discoverPrUrl(w));
		this.ciMonitor = new CIMonitorCoordinator(startMonitoring, discoverPrUrlFn);
		this.questionDetector = deps?.questionDetector ?? new QuestionDetector();
		this.reviewClassifier = deps?.reviewClassifier ?? new ReviewClassifier();
		this.summarizer = deps?.summarizer ?? new Summarizer();
		this.auditLogger = deps?.auditLogger ?? new AuditLogger();
		this.store = deps?.workflowStore ?? new WorkflowStore();
		this.managedRepoStore = deps?.managedRepoStore ?? null;
		this.runSetupChecksFn = deps?.runSetupChecks ?? defaultRunSetupChecks;
		this.ensureSpeckitSkillsFn = deps?.ensureSpeckitSkills ?? defaultEnsureSpeckitSkills;
		this.appendProjectClaudeMdFn = deps?.appendProjectClaudeMd ?? defaultAppendProjectClaudeMd;
		this.markClaudeMdSkipWorktreeFn =
			deps?.markClaudeMdSkipWorktree ?? defaultMarkClaudeMdSkipWorktree;
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
		this.guardClaudeMdFn = deps?.guardClaudeMd ?? defaultGuardClaudeMd;
		this.gitPushFeatureBranchFn =
			deps?.gitPushFeatureBranch ??
			(async (cwd: string, branch: string) => {
				const res = await gitSpawn(["git", "push", "-u", "origin", branch], { cwd });
				return { code: res.code, stderr: res.stderr };
			});
		this.ghPrCreateFn =
			deps?.ghPrCreate ??
			(async (cwd: string) => gitSpawn(["gh", "pr", "create", "--fill"], { cwd }));
		this.maxStepOutputChars = deps?.maxStepOutputChars ?? MAX_STEP_OUTPUT_CHARS;
		this.callbacks = callbacks;
		this.ciMergeFlow = new CiMergeFlowController({
			ciMonitor: this.ciMonitor,
			mergePr: deps?.mergePr ?? defaultMergePr,
			resolveConflicts: deps?.resolveConflicts ?? defaultResolveConflicts,
			syncRepo: deps?.syncRepo ?? defaultSyncRepo,
			discoverPrUrl: discoverPrUrlFn,
			stepOutput: (id, msg) => this.handleStepOutput(id, msg),
			engine: this.engine,
		});
	}

	getEngine(): WorkflowEngine {
		return this.engine;
	}

	/** Start the pipeline for an already-created workflow (used by epic flow). */
	startPipelineFromWorkflow(workflow: Workflow): void {
		runInWorkflowContext(workflow.id, () => {
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
		});
	}

	async startPipeline(
		specification: string,
		targetRepository: string,
		managedRepo: Workflow["managedRepo"] = null,
		options: { workflowKind?: import("./types").WorkflowKind } = {},
	): Promise<Workflow> {
		const workflow = await this.engine.createWorkflow(
			specification,
			targetRepository,
			managedRepo,
			options,
		);
		return runInWorkflowContext(workflow.id, async () => {
			this.engine.transition(workflow.id, "running");

			const branchCwd = targetRepository;
			this.pipelineName = (await this.getBranch(branchCwd)) ?? workflow.worktreeBranch;
			this.currentAuditRunId = this.auditLogger.startRun(
				this.pipelineName,
				workflow.worktreeBranch,
			);

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
		});
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
		runInWorkflowContext(workflowId, () => {
			const workflow = this.getWorkflowOrThrow(workflowId);

			if (!workflow.pendingQuestion || workflow.pendingQuestion.id !== questionId) {
				return;
			}

			if (this.currentAuditRunId) {
				const stepName = workflow.steps[workflow.currentStepIndex]?.name ?? null;
				this.auditLogger.logAnswer(this.currentAuditRunId, answer, stepName);
			}

			this.engine.clearQuestion(workflowId);
			this.markQuestionAlertSeen(workflowId);
			const step = workflow.steps[workflow.currentStepIndex];

			// Append the user's answer to step output so it is visible and persisted
			const answerLine = `[Human] ${answer}`;
			step.output += `${answerLine}\n`;
			step.outputLog.push({ kind: "text", text: answerLine });
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
				this.dispatchCiFlow(
					workflow,
					this.ciMergeFlow.answerMonitorCancelledQuestion(workflow, answer),
				);
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
			const answerConfig = configStore.get();
			const answerConfigKey = STEP_CONFIG_KEY[step.name];
			const permit = prepareLlmDispatch(
				workflow,
				step,
				answerConfigKey ? answerConfig.models[answerConfigKey] : undefined,
				answerConfigKey ? answerConfig.efforts[answerConfigKey] : undefined,
			);
			this.persistWorkflow(workflow);
			this.callbacks.onStateChange(workflowId);
			this.stepRunner.resumeStep(
				workflowId,
				sessionId,
				cwd,
				permit,
				this.buildStepCallbacks(workflowId),
				this.buildStepEnv(workflow),
				answer,
			);
		});
	}

	skipQuestion(workflowId: string, questionId: string): void {
		this.answerQuestion(
			workflowId,
			questionId,
			"The user has chosen not to answer this question. Continue with your best judgment.",
		);
	}

	resumeMonitorCi(workflowId: string): void {
		runInWorkflowContext(workflowId, () => {
			const workflow = this.getWorkflowOrThrow(workflowId);
			if (workflow.status !== "running") return;

			const step = workflow.steps[workflow.currentStepIndex];
			if (step.name !== STEP.MONITOR_CI) return;

			this.dispatchCiFlow(workflow, this.ciMergeFlow.runMonitorCi(workflow));
		});
	}

	async resumeStep(workflowId: string): Promise<void> {
		return runInWorkflowContext(workflowId, async () => {
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

			const resumeConfig = configStore.get();
			const resumeConfigKey = STEP_CONFIG_KEY[step.name];
			const permit = prepareLlmDispatch(
				workflow,
				step,
				resumeConfigKey ? resumeConfig.models[resumeConfigKey] : undefined,
				resumeConfigKey ? resumeConfig.efforts[resumeConfigKey] : undefined,
			);
			this.persistWorkflow(workflow);
			this.callbacks.onStateChange(workflowId);
			this.stepRunner.resumeStep(
				workflowId,
				step.sessionId,
				cwd,
				permit,
				this.buildStepCallbacks(workflowId),
				this.buildStepEnv(workflow),
				undefined,
			);
		});
	}

	async retryStep(workflowId: string): Promise<void> {
		return runInWorkflowContext(workflowId, async () => {
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
				// User-initiated retry grants a fresh attempt budget and picks up any
				// config changes. Without this, a retry after "CI checks still failing
				// after N fix attempts" would re-trip the exhausted check immediately.
				workflow.ciCycle.attempt = 0;
				workflow.ciCycle.monitorStartedAt = null;
				workflow.ciCycle.maxAttempts = configStore.get().limits.ciFixMaxAttempts;
				this.dispatchCiFlow(workflow, this.ciMergeFlow.runMonitorCi(workflow));
				return;
			}

			if (step.name === STEP.FIX_CI) {
				this.dispatchCiFlow(workflow, this.ciMergeFlow.runFixCi(workflow));
				return;
			}

			if (step.name === STEP.MERGE_PR) {
				workflow.mergeCycle.attempt = 0;
				this.dispatchCiFlow(workflow, this.ciMergeFlow.runMergePr(workflow));
				return;
			}

			if (step.name === STEP.SYNC_REPO) {
				this.dispatchCiFlow(workflow, this.ciMergeFlow.runSyncRepo(workflow));
				return;
			}

			if (step.name === STEP.FIX_IMPLEMENT) {
				// fix-implement has an empty static prompt and depends on a
				// pre-run HEAD snapshot. Falling through to runStep(step.prompt)
				// would spawn the CLI with no prompt and leave completeFixImplement
				// comparing against a stale/null pre-run HEAD.
				this.runFixImplement(workflow).catch((err) => {
					this.handleStepError(workflow.id, toErrorMessage(err));
				});
				return;
			}

			if (step.name === STEP.ARTIFACTS) {
				// Artifacts uses a dynamically-built prompt (output dir varies per
				// workflow) and its own wall-clock timer; the generic runStep path
				// would spawn the CLI with the empty static prompt and no budget.
				this.runArtifactsStep(workflow);
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
		});
	}

	pause(workflowId: string): void {
		runInWorkflowContext(workflowId, () => {
			const workflow = this.getActiveWorkflow(workflowId);
			if (!workflow || workflow.status !== "running") return;

			this.clearArtifactsTimer(workflowId);
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
		});
	}

	resume(workflowId: string): void {
		runInWorkflowContext(workflowId, () => {
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
				this.dispatchCiFlow(workflow, this.ciMergeFlow.runMonitorCi(workflow));
			} else if (step.name === STEP.FIX_CI) {
				this.dispatchCiFlow(workflow, this.ciMergeFlow.runFixCi(workflow));
			} else if (step.name === STEP.FEEDBACK_IMPLEMENTER) {
				if (step.sessionId) {
					const fiConfig = configStore.get();
					const fiPermit = prepareLlmDispatch(
						workflow,
						step,
						fiConfig.models.implement,
						fiConfig.efforts.implement,
					);
					this.persistWorkflow(workflow);
					this.callbacks.onStateChange(workflowId);
					this.stepRunner.resumeStep(
						workflowId,
						step.sessionId,
						cwd,
						fiPermit,
						this.buildStepCallbacks(workflowId),
						this.buildStepEnv(workflow),
						undefined,
					);
				} else {
					this.runFeedbackImplementer(workflow).catch((err) => {
						this.handleStepError(workflowId, toErrorMessage(err));
					});
				}
			} else if (step.name === STEP.MERGE_PR) {
				workflow.mergeCycle.attempt = 0;
				this.dispatchCiFlow(workflow, this.ciMergeFlow.runMergePr(workflow));
			} else if (step.name === STEP.SYNC_REPO) {
				this.dispatchCiFlow(workflow, this.ciMergeFlow.runSyncRepo(workflow));
			} else if (step.name === STEP.ARTIFACTS) {
				// Don't resume the prior artifacts session — its timer and output
				// dir state are gone. Restart the step from scratch with a fresh
				// wall-clock budget and manifest.
				this.runArtifactsStep(workflow);
			} else if (step.sessionId) {
				const resumedConfig = configStore.get();
				const resumedConfigKey = STEP_CONFIG_KEY[step.name];
				const resumedPermit = prepareLlmDispatch(
					workflow,
					step,
					resumedConfigKey ? resumedConfig.models[resumedConfigKey] : undefined,
					resumedConfigKey ? resumedConfig.efforts[resumedConfigKey] : undefined,
				);
				this.persistWorkflow(workflow);
				this.callbacks.onStateChange(workflowId);
				this.stepRunner.resumeStep(
					workflowId,
					step.sessionId,
					cwd,
					resumedPermit,
					this.buildStepCallbacks(workflowId),
					this.buildStepEnv(workflow),
					undefined,
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
		});
	}

	abortPipeline(workflowId: string): void {
		runInWorkflowContext(workflowId, () => {
			const workflow = this.getWorkflowOrThrow(workflowId);

			if (this.currentAuditRunId) {
				this.auditLogger.endRun(this.currentAuditRunId, { aborted: true });
				this.currentAuditRunId = null;
			}

			this.clearArtifactsTimer(workflowId);
			this.stepRunner.killProcess(workflowId);
			this.ciMonitor.abort();
			this.summarizer.cleanup(workflowId);
			this.resetStepState();
			this.engine.clearQuestion(workflowId);
			this.markQuestionAlertSeen(workflowId);

			const step = workflow.steps[workflow.currentStepIndex];

			// If aborting a feedback-implementer run, record the in-flight entry as aborted
			// (FR-019). Git-based commit detection runs fire-and-forget — the outcome is
			// immediately persisted with commitRefs: [] and backfilled when detection resolves.
			if (step.name === STEP.FEEDBACK_IMPLEMENTER) {
				const latest = workflow.feedbackEntries[workflow.feedbackEntries.length - 1];
				if (latest && latest.outcome === null) {
					latest.outcome = {
						value: "aborted",
						summary: "Aborted by user",
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
								// Best-effort commit backfill — agent already aborted.
								// Surface the failure so a missing commitRefs on an aborted
								// entry can be traced back to this path instead of silently
								// showing []. Production detectNewCommits swallows its own
								// errors; this fires only when a custom/test-injected fn throws.
								logger.warn(
									`[pipeline] Post-abort commit backfill failed for workflow ${workflowId}: ${toErrorMessage(err)}`,
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
				step.error = "Aborted by user";
			}

			this.tryTransition(workflowId, "aborted");

			step.pid = null;
			this.flushPersistDebounce();
			this.persistWorkflow(workflow);
			this.callbacks.onStateChange(workflowId);

			// If this workflow cloned from a URL, release the managed-repo refcount so the
			// clone is cleaned up once it has no remaining consumers. sync-repo (which is
			// the release hook for normal completion) does not run on abort.
			this.releaseManagedRepoIfAny(workflow);

			// Update epic dependency status for siblings if this workflow was aborted,
			// and emit `epic-finished` when every sibling has reached a terminal state.
			if (workflow.epicId) {
				this.checkEpicDependencies(workflow).catch((err) => {
					logger.error(`[pipeline] Failed to check epic dependencies: ${err}`);
				});
			}
		});
	}

	/**
	 * Accept a feedback submission on a manual-mode merge-pr pause. Non-empty
	 * text creates a new FeedbackEntry and starts the feedback-implementer step.
	 * The WS handler always routes empty/whitespace input straight to resume()
	 * and never reaches this method with empty text; the empty-text early-return
	 * below exists as a defensive no-op for direct programmatic callers.
	 */
	submitFeedback(workflowId: string, text: string): void {
		runInWorkflowContext(workflowId, () => {
			const workflow = this.getWorkflowOrThrow(workflowId);
			const trimmed = text.trim();

			const step = workflow.steps[workflow.currentStepIndex];

			// FR-016: on an errored fix-implement step, appended feedback is treated
			// as retry context and the step is re-entered via runFixImplement. Empty
			// text is not a "resume" here — the workflow is in `error`, not paused —
			// so reject it instead of silently no-op'ing.
			if (workflow.status === "error" && step?.name === STEP.FIX_IMPLEMENT) {
				if (trimmed === "") {
					logger.warn(
						`[pipeline] submitFeedback rejected for workflow ${workflowId}: empty feedback on errored fix-implement`,
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
					submittedAtStepName: STEP.FIX_IMPLEMENT,
					outcome: null,
				};
				workflow.feedbackEntries.push(entry);
				workflow.updatedAt = now;

				this.stepRunner.resetStep(step);
				this.engine.transition(workflowId, "running");
				this.startStep(workflow);
				return;
			}

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
		});
	}

	private async runFixImplement(workflow: Workflow): Promise<void> {
		const cwd = requireWorktreePath(workflow);
		const preRunHead = await this.getGitHeadFn(cwd);
		workflow.feedbackPreRunHead = preRunHead;
		this.persistWorkflow(workflow);

		const current = this.getActiveWorkflow(workflow.id);
		const currentStep = current?.steps[current.currentStepIndex];
		if (
			!current ||
			current.status !== "running" ||
			currentStep?.name !== STEP.FIX_IMPLEMENT ||
			currentStep.status !== "running"
		) {
			return;
		}

		const config = configStore.get();
		const prompt = buildFixImplementPrompt(workflow);
		this.runStep(workflow, prompt, cwd, config.models.implement, config.efforts.implement);
	}

	private async completeFixImplement(workflow: Workflow): Promise<void> {
		// If the CLI emitted an AskUserQuestion tool_use, pause for that
		// question instead of running the diff classifier. Without this
		// the step would be routed through the empty-diff error path even
		// though the agent is actively waiting on operator input.
		const step = workflow.steps[workflow.currentStepIndex];
		const askedQuestion = findAskUserQuestion(step.outputLog);
		if (askedQuestion) {
			this.pauseForQuestion(workflow.id, {
				id: randomUUID(),
				content: askedQuestion,
				detectedAt: new Date().toISOString(),
			});
			return;
		}

		const cwd = workflow.worktreePath;
		const preRunHead = workflow.feedbackPreRunHead;
		const postRunHead = cwd ? await this.getGitHeadFn(cwd) : null;
		workflow.feedbackPreRunHead = null;

		const diff = classifyFixImplementDiff(preRunHead, postRunHead);
		if (diff.kind === "head-read-failed") {
			this.handleStepError(workflow.id, FIX_IMPLEMENT_HEAD_READ_FAILED_MESSAGE);
			return;
		}
		if (diff.kind === "empty") {
			// Mark the latest in-flight feedback entry (if any) as produced no changes
			const latest = workflow.feedbackEntries[workflow.feedbackEntries.length - 1];
			if (latest && latest.outcome === null) {
				latest.outcome = {
					value: "no changes",
					summary: FIX_IMPLEMENT_EMPTY_DIFF_MESSAGE,
					commitRefs: [],
					warnings: [],
				};
			}
			this.handleStepError(workflow.id, FIX_IMPLEMENT_EMPTY_DIFF_MESSAGE);
			return;
		}
		this.persistWorkflow(workflow);
		this.advanceAfterStep(workflow.id);
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
			workflow.ciCycle.userFixGuidance = null;
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
		this.applyCiFlowOutcome(workflow, this.ciMergeFlow.routeToMergePrPause());
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
			this.dispatchCiFlow(workflow, this.ciMergeFlow.runMonitorCi(workflow));
			return;
		}

		if (step.name === STEP.FIX_CI) {
			this.dispatchCiFlow(workflow, this.ciMergeFlow.runFixCi(workflow));
			return;
		}

		if (step.name === STEP.FEEDBACK_IMPLEMENTER) {
			this.runFeedbackImplementer(workflow).catch((err) => {
				this.handleStepError(workflow.id, toErrorMessage(err));
			});
			return;
		}

		if (step.name === STEP.FIX_IMPLEMENT) {
			this.runFixImplement(workflow).catch((err) => {
				this.handleStepError(workflow.id, toErrorMessage(err));
			});
			return;
		}

		if (step.name === STEP.ARTIFACTS) {
			this.runArtifactsStep(workflow);
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
			this.dispatchCiFlow(workflow, this.ciMergeFlow.runMergePr(workflow));
			return;
		}

		if (step.name === STEP.SYNC_REPO) {
			this.dispatchCiFlow(workflow, this.ciMergeFlow.runSyncRepo(workflow));
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

	/**
	 * After the agent's commit phase completes: run the CLAUDE.md guard (restore
	 * the merge-base version if the agent touched CLAUDE.md), then programmatically
	 * `git push -u origin <branch>` and `gh pr create --fill`. Capture the PR URL
	 * and route as before. Any failure routes to `handleStepError`.
	 */
	private async completeCommitPushPr(workflow: Workflow): Promise<void> {
		const cwd = requireWorktreePath(workflow);

		const guardResult = await this.guardClaudeMdFn(cwd);
		if (guardResult.outcome === "unchanged") {
			this.handleStepOutput(workflow.id, "✓ CLAUDE.md unchanged vs merge-base — no restore needed");
		} else if (guardResult.outcome === "restored") {
			this.handleStepOutput(
				workflow.id,
				`✓ Restored CLAUDE.md (${guardResult.action}) in ${guardResult.commitSha.slice(0, 7)}`,
			);
		} else {
			const warnMsg = "⚠ No merge-base with origin/master — skipping CLAUDE.md restore";
			this.handleStepOutput(workflow.id, warnMsg);
			// Also surface to the server log for postmortem — this path is rare
			// (disjoint histories) and matches the in-guard warn pattern.
			logger.warn(`[claude-md-guard] ${warnMsg} (workflow=${workflow.id})`);
		}

		const branch = workflow.featureBranch ?? workflow.worktreeBranch;
		if (!branch) {
			throw new Error("completeCommitPushPr: no feature branch available for push");
		}

		const push = await this.gitPushFeatureBranchFn(cwd, branch);
		if (push.code !== 0) {
			throw new Error(`git push -u origin ${branch} failed: ${push.stderr || `exit ${push.code}`}`);
		}

		const prRes = await this.ghPrCreateFn(cwd);
		let url: string | null = null;
		let reusedExistingPr = false;
		if (prRes.code !== 0) {
			// `gh pr create` exits non-zero when a PR for the branch already exists.
			// The stderr typically contains the existing PR URL, e.g.:
			//   a pull request for branch "X" into branch "Y" already exists:
			//   https://github.com/owner/repo/pull/123
			// In that case, reuse the existing PR rather than failing the step.
			if (/already exists/i.test(prRes.stderr) || /already exists/i.test(prRes.stdout)) {
				url = extractPrUrl(prRes.stderr) ?? extractPrUrl(prRes.stdout);
				if (!url) {
					url = await this.ciMergeFlow.discoverPrUrl(workflow);
				}
				if (!url) {
					throw new Error(
						`gh pr create reported PR already exists but URL could not be discovered: ${prRes.stderr || `exit ${prRes.code}`}`,
					);
				}
				reusedExistingPr = true;
			} else {
				throw new Error(`gh pr create failed: ${prRes.stderr || `exit ${prRes.code}`}`);
			}
		} else {
			url = extractPrUrl(prRes.stdout) ?? extractPrUrl(prRes.stderr);
		}

		if (url) {
			const firstPr = !workflow.prUrl;
			workflow.prUrl = url;
			const step = workflow.steps[workflow.currentStepIndex];
			if (reusedExistingPr) {
				const note = `✓ PR already exists for ${branch} — reusing ${url}`;
				step.output += `${note}\n`;
				step.outputLog.push({ kind: "text", text: note });
				this.callbacks.onOutput(workflow.id, note);
			}
			step.output += `${url}\n`;
			step.outputLog.push({ kind: "text", text: url });
			this.callbacks.onOutput(workflow.id, url);
			if (firstPr && configStore.get().autoMode === "manual") {
				this.emitAlert(
					"pr-opened-manual",
					workflow,
					"PR opened — ready to review",
					`${workflow.summary || workflow.specification.slice(0, 80)} — ${url}`,
				);
			}
		}

		this.routeAfterStep(workflow);
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
		if (workflow.workflowKind === "quick-fix") {
			this.initQuickFixBranch(workflow);
			return;
		}
		const cwd = requireWorktreePath(workflow);
		this.handleStepOutput(workflow.id, "[speckit] Ensuring spec-kit skills in worktree");

		this.ensureSpeckitSkillsFn(cwd)
			.then(async ({ installed, initResult }) => {
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

				if (wf.workflowKind === "spec") {
					const append = await this.appendProjectClaudeMdFn(cwd);
					const stillActive = this.getActiveWorkflow(workflow.id);
					if (!stillActive) return;
					switch (append.outcome) {
						case "appended":
							this.handleStepOutput(stillActive.id, "✓ Appended project CLAUDE.md");
							break;
						case "skipped":
							this.handleStepOutput(stillActive.id, "✓ Project CLAUDE.md already appended");
							break;
						case "no-project":
							this.handleStepOutput(
								stillActive.id,
								"• No project CLAUDE.md in main worktree — skipping append",
							);
							break;
						case "no-main":
							logger.warn("[pipeline] Could not resolve main worktree; skipping CLAUDE.md append");
							this.handleStepOutput(
								stillActive.id,
								"• Could not resolve main worktree — skipping project CLAUDE.md append",
							);
							break;
					}

					// Mark CLAUDE.md skip-worktree so the assembled file (and any
					// later modification by an agent) cannot be staged or
					// committed on the spec branch. claude-md-guard only fires
					// at commit-push-pr and is bypassed if the workflow is
					// merged before that step runs.
					const skip = await this.markClaudeMdSkipWorktreeFn(cwd);
					const stillActive2 = this.getActiveWorkflow(workflow.id);
					if (!stillActive2) return;
					if (skip.outcome === "marked") {
						this.handleStepOutput(stillActive2.id, "✓ CLAUDE.md marked skip-worktree");
					} else {
						this.handleStepOutput(
							stillActive2.id,
							"• CLAUDE.md not tracked in index — skip-worktree not applicable",
						);
					}

					this.advanceAfterStep(stillActive2.id);
					return;
				}

				this.advanceAfterStep(wf.id);
			})
			.catch((err) => {
				this.handleStepError(workflow.id, `Failed to initialize spec-kit: ${toErrorMessage(err)}`);
			});
	}

	private async initQuickFixBranch(workflow: Workflow): Promise<void> {
		try {
			const cwd = requireWorktreePath(workflow);
			const targetRepo = requireTargetRepository(workflow);
			this.handleStepOutput(workflow.id, "[quick-fix] Allocating fix branch name");

			const branchList = await gitSpawn(["git", "branch", "-a"], { cwd });
			// Pause/abort race: matches the pattern used by every sibling setup
			// continuation — after each await, bail if the workflow is no longer
			// running so we don't mutate featureBranch / worktree on disk behind a
			// user who has already paused or aborted.
			{
				const wf = this.getActiveWorkflow(workflow.id);
				if (!wf || wf.status !== "running") return;
			}
			const existing = branchList.code === 0 ? branchList.stdout.split(/\r?\n/) : [];
			const branchName = nextFixBranchName(workflow.specification, existing);

			const checkout = await gitSpawn(["git", "checkout", "-b", branchName], { cwd });
			{
				const wf = this.getActiveWorkflow(workflow.id);
				if (!wf || wf.status !== "running") return;
			}
			if (checkout.code !== 0) {
				this.handleStepError(
					workflow.id,
					`Failed to create fix branch ${branchName}: ${checkout.stderr || checkout.code}`,
				);
				return;
			}
			this.handleStepOutput(workflow.id, `✓ Created fix branch ${branchName}`);

			workflow.featureBranch = branchName;
			workflow.worktreeBranch = branchName;

			// Rename worktree dir to match the branch (non-fatal on failure).
			if (workflow.worktreePath) {
				const newRelativePath = `.worktrees/${branchName.replace(/\//g, "-")}`;
				try {
					const newAbsPath = await this.engine.moveWorktree(
						workflow.worktreePath,
						newRelativePath,
						targetRepo,
					);
					const wf = this.getActiveWorkflow(workflow.id);
					if (!wf || wf.status !== "running") return;
					workflow.worktreePath = newAbsPath;
				} catch (err) {
					logger.warn(
						`[pipeline] Quick-fix worktree rename failed (non-fatal): ${toErrorMessage(err)}`,
					);
				}
			}
			this.persistWorkflow(workflow);
			this.callbacks.onStateChange(workflow.id);
			this.advanceAfterStep(workflow.id);
		} catch (err) {
			this.handleStepError(
				workflow.id,
				`Failed to initialize quick-fix branch: ${toErrorMessage(err)}`,
			);
		}
	}

	private dispatchCiFlow(workflow: Workflow, work: Promise<CiFlowOutcome>): void {
		work
			.then((outcome) => this.applyCiFlowOutcome(workflow, outcome))
			.catch((err) => this.handleStepError(workflow.id, toErrorMessage(err)));
	}

	private rewindToStep(workflow: Workflow, name: PipelineStepName): void {
		const idx = this.requireStepIndex(workflow, name);
		this.stepRunner.resetStep(workflow.steps[idx], "pending");
		workflow.currentStepIndex = idx;
		this.persistWorkflow(workflow);
		this.startStep(workflow);
	}

	/**
	 * Single reaction site for every CiFlowOutcome the controller emits. This
	 * is the ONLY place that reads `workflow.status` for the CI flow (FR-014),
	 * so all pause/abort short-circuits live here. The re-fetch via
	 * `getActiveWorkflow` is what makes pause/abort race-safe — between the
	 * controller awaiting an async helper and this method firing, the workflow
	 * may have been paused or aborted, in which case `current.status !==
	 * "running"` and the reaction is skipped. The `done` arm is the explicit
	 * no-op fallback for outcomes that already resolved their own follow-up.
	 */
	private applyCiFlowOutcome(workflow: Workflow, outcome: CiFlowOutcome): void {
		const current = this.getActiveWorkflow(workflow.id);
		if (!current || current.status !== "running") {
			logger.info(
				`[pipeline] applyCiFlowOutcome skipped for ${workflow.id}: status=${current?.status ?? "missing"}`,
			);
			return;
		}

		switch (outcome.kind) {
			case "advance":
				this.advanceAfterStep(current.id);
				return;
			case "advanceToFixCi": {
				const step = current.steps[current.currentStepIndex];
				step.status = "completed";
				step.completedAt = new Date().toISOString();
				step.pid = null;
				current.updatedAt = new Date().toISOString();
				this.flushPersistDebounce();
				this.persistWorkflow(current);
				current.currentStepIndex = this.requireStepIndex(current, STEP.FIX_CI);
				this.startStep(current);
				return;
			}
			case "routeBackToMonitor":
				if (outcome.incrementMergeAttempt) current.mergeCycle.attempt++;
				current.ciCycle.attempt++;
				current.ciCycle.monitorStartedAt = null;
				current.ciCycle.failureLogs = [];
				this.rewindToStep(current, STEP.MONITOR_CI);
				return;
			case "routeToMergePrPause":
				this.rewindToStep(current, STEP.MERGE_PR);
				return;
			case "retryMergeAfterAlreadyUpToDate":
				this.dispatchCiFlow(current, this.ciMergeFlow.retryMergeAfterAlreadyUpToDate(current));
				return;
			case "pauseForQuestion":
				this.pauseForQuestion(current.id, outcome.question);
				return;
			case "runCliStep":
				current.ciCycle.failureLogs = outcome.failureLogs;
				if (outcome.clearUserFixGuidance) current.ciCycle.userFixGuidance = null;
				this.persistWorkflow(current);
				this.runStep(
					current,
					outcome.prompt,
					requireWorktreePath(current),
					outcome.model,
					outcome.effort,
				);
				return;
			case "error":
				this.handleStepError(current.id, outcome.message);
				return;
			case "done":
				return;
		}
	}

	private runStep(
		workflow: Workflow,
		prompt: string,
		cwd: string,
		model: string | undefined,
		effort: EffortLevel | undefined,
	): void {
		// Inject accumulated user feedback as authoritative context into every
		// CLI-spawned step (FR-010). Skip for feedback-implementer, whose prompt
		// template already interpolates ${feedbackContext} directly, and for
		// fix-implement, whose prompt builder (`buildFixImplementPrompt`) already
		// appends any in-flight retry-guidance inline — prepending here would
		// duplicate the same text under a second header.
		//
		// The CLAUDE.md-is-Litus-managed contract header is NOT prepended here: it
		// is injected via `--append-system-prompt` in `CLIRunner.start()` so that
		// slash-command step prompts (e.g. `/speckit-specify`) remain intercepted
		// by Claude Code's `-p` mode, which only triggers on a leading `/`.
		const step = workflow.steps[workflow.currentStepIndex];
		if (!step) {
			throw new Error(
				`runStep called with invalid currentStepIndex=${workflow.currentStepIndex} for workflow ${workflow.id}`,
			);
		}
		let finalPrompt = prompt;
		if (step.name !== STEP.FEEDBACK_IMPLEMENTER && step.name !== STEP.FIX_IMPLEMENT) {
			const feedbackCtx = buildFeedbackContext(workflow);
			if (feedbackCtx) finalPrompt = `${feedbackCtx}\n\n---\n\n${prompt}`;
		}
		const stepWorkflow: Workflow = {
			...workflow,
			specification: finalPrompt,
			worktreePath: cwd,
		};

		// `prepareLlmDispatch` updates workflow.activeInvocation atomically with
		// the dispatch. The returned permit is the only way to call
		// `stepRunner.startStep`, so callers cannot dispatch the LLM without
		// refreshing the model the UI displays.
		const permit = prepareLlmDispatch(workflow, step, model, effort);
		this.persistWorkflow(workflow);
		this.callbacks.onStateChange(workflow.id);

		this.stepRunner.startStep(
			stepWorkflow,
			permit,
			this.buildStepCallbacks(workflow.id),
			this.buildStepEnv(workflow),
		);
	}

	private handleStepOutput(workflowId: string, text: string): void {
		const workflow = this.getActiveWorkflow(workflowId);
		if (!workflow) return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.output += `${text}\n`;
		step.outputLog.push({ kind: "text", text });
		enforceStepOutputCap(step, this.maxStepOutputChars);
		workflow.updatedAt = new Date().toISOString();

		this.engine.updateLastOutput(workflowId, text);
		this.callbacks.onOutput(workflowId, text);
		this.persistDebounced(workflow);

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

	private clearArtifactsTimer(workflowId: string): ArtifactsStepState | null {
		const entry = this.artifactsState.get(workflowId);
		if (!entry) return null;
		clearTimeout(entry.timeoutHandle);
		this.artifactsState.delete(workflowId);
		return entry;
	}

	private runArtifactsStep(workflow: Workflow): void {
		// The wall-clock timer below lives only on this orchestrator instance.
		// A server restart drops it along with the in-flight step; on resume the
		// user must retry/resume to re-arm a fresh timer. Acceptable for the
		// single-user local app.
		// Abort any stale timer from a previous attempt on the same workflow.
		this.clearArtifactsTimer(workflow.id);

		const cwd = requireWorktreePath(workflow);
		const config = configStore.get();
		const branch = getWorkflowBranch(workflow);
		const outputDir = join(cwd, "specs", branch, "artifacts-output");

		try {
			mkdirSync(outputDir, { recursive: true });
		} catch (err) {
			this.handleStepError(
				workflow.id,
				`Failed to prepare artifacts output directory: ${toErrorMessage(err)}`,
			);
			return;
		}

		const timeoutMs = config.timing.artifactsTimeoutMs;
		const state: ArtifactsStepState = {
			timeoutHandle: setTimeout(() => {
				const entry = this.artifactsState.get(workflow.id);
				if (!entry) return;
				entry.timedOut = true;
				logger.warn(
					`[artifacts] Wall-clock timeout ${timeoutMs}ms hit for workflow ${workflow.id} — killing CLI`,
				);
				this.stepRunner.killProcess(workflow.id);
			}, timeoutMs),
			timedOut: false,
			outputDir,
			perFileMaxBytes: config.limits.artifactsPerFileMaxBytes,
			perStepMaxBytes: config.limits.artifactsPerStepMaxBytes,
		};
		this.artifactsState.set(workflow.id, state);

		if (this.currentAuditRunId) {
			this.auditLogger.logArtifactsStart(this.currentAuditRunId, {
				workflowId: workflow.id,
				model: config.models.artifacts,
				effort: config.efforts.artifacts,
			});
		}

		const prompt = buildArtifactsPrompt(outputDir);
		this.runStep(workflow, prompt, cwd, config.models.artifacts, config.efforts.artifacts);
	}

	private completeArtifactsStep(workflow: Workflow): void {
		const state = this.clearArtifactsTimer(workflow.id);
		if (!state) {
			// Indicates the step completed without ever arming its timer — a
			// "shouldn't happen" branch that would otherwise silently mint an
			// empty outcome and mask whatever bug put us here. Surface it as an
			// error so both the audit log and the workflow state reflect the
			// anomaly.
			const reason = "artifacts step completed without timer state";
			logger.warn(`[artifacts] ${reason} for workflow ${workflow.id}`);
			this.finishArtifactsStep(workflow, {
				outcome: "error",
				accepted: [],
				rejections: [],
				errorKind: "state-missing",
				errorMessage: reason,
			});
			return;
		}

		const result = collectArtifactsFromManifest(workflow, state.outputDir, {
			perFileMaxBytes: state.perFileMaxBytes,
			perStepMaxBytes: state.perStepMaxBytes,
		});
		this.finishArtifactsStep(workflow, result);
	}

	private finishArtifactsStep(workflow: Workflow, result: ArtifactsCollectionResult): void {
		const step = workflow.steps[workflow.currentStepIndex];

		for (const rej of result.rejections) {
			const reasonLabel =
				rej.reason === "file-cap-exceeded"
					? "exceeds the per-file cap"
					: "would exceed the per-step total cap";
			this.handleStepOutput(
				workflow.id,
				`[artifacts] Rejected ${rej.relPath} (${rej.sizeBytes} bytes — ${reasonLabel})`,
			);
		}

		if (result.outcome === "error") {
			const reason = result.errorMessage ?? "artifacts collection failed";
			this.auditArtifactsEnd(workflow.id, "error", {
				reason: `${result.errorKind}: ${reason}`,
				rejections: result.rejections.map((r) => ({ relPath: r.relPath, reason: r.reason })),
			});
			step.outcome = null;
			this.handleStepError(workflow.id, reason);
			return;
		}

		step.outcome = result.outcome;
		this.auditArtifactsEnd(workflow.id, result.outcome, {
			files: result.accepted.map((a) => ({ relPath: a.relPath, sizeBytes: a.sizeBytes })),
			rejections: result.rejections.map((r) => ({ relPath: r.relPath, reason: r.reason })),
		});

		if (result.outcome === "empty") {
			this.handleStepOutput(workflow.id, "[artifacts] Step completed with no files produced");
		} else {
			this.handleStepOutput(workflow.id, `[artifacts] Collected ${result.accepted.length} file(s)`);
		}

		this.advanceAfterStep(workflow.id);
	}

	private auditArtifactsEnd(
		workflowId: string,
		outcome: "with-files" | "empty" | "error",
		extras: {
			reason?: string;
			files?: Array<{ relPath: string; sizeBytes: number }>;
			rejections?: Array<{ relPath: string; reason: string }>;
		},
	): void {
		if (!this.currentAuditRunId) return;
		// Include the caps + timeout in effect so auditors can distinguish
		// between "rejected because the file was huge" and "rejected because the
		// cap was just lowered" (FR-015).
		const config = configStore.get();
		this.auditLogger.logArtifactsEnd(this.currentAuditRunId, {
			workflowId,
			outcome,
			reason: extras.reason,
			files: extras.files,
			rejections: extras.rejections,
			caps: {
				perFileMaxBytes: config.limits.artifactsPerFileMaxBytes,
				perStepMaxBytes: config.limits.artifactsPerStepMaxBytes,
			},
			timeoutMs: config.timing.artifactsTimeoutMs,
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

		// Artifacts runs before the empty-output guard: the LLM may legitimately
		// emit only the manifest and exit with no chat text. Collection is
		// driven by the manifest file on disk, not by the step's transcript.
		if (step.name === STEP.ARTIFACTS) {
			this.completeArtifactsStep(workflow);
			return;
		}

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

		if (step.name === STEP.FIX_IMPLEMENT) {
			this.completeFixImplement(workflow).catch((err) => {
				this.handleStepError(workflowId, toErrorMessage(err));
			});
			return;
		}

		// Detect only from the finalized-assistant buffer — partial deltas can
		// synthesize or duplicate a question (the bug this branch fixes). The
		// modern CLI always emits an `assistant` event at block boundaries, so
		// failing closed is safer than a fallback to the known-broken path.
		const candidate = this.questionDetector.detectFromFinalized();
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
		// aborted the workflow. Advancing in that case would silently start the next
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
			this.completeCommitPushPr(workflow).catch((err) => {
				this.handleStepError(workflow.id, toErrorMessage(err));
			});
			return;
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
					this.applyCiFlowOutcome(workflow, this.ciMergeFlow.routeBackToMonitor());
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
		// NOTE: reviewCycle.iteration is NOT bumped here. It tracks the
		// currently-running review iteration and must stay stable across the
		// review → implement-review pair so artifact snapshots for both steps
		// line up on the same ordinal / code-review file. It is bumped in
		// `handleImplementReviewComplete` only when the cycle loops back for
		// another review.

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
			// Advance the iteration counter only when we actually loop back
			// for a new review. This keeps iteration equal to the number of
			// review cycles that have actually started.
			workflow.reviewCycle.iteration++;

			// Reset review step and loop back
			const step = workflow.steps[reviewIndex];
			this.stepRunner.resetStep(step, "pending");

			workflow.currentStepIndex = reviewIndex;
			this.persistWorkflow(workflow);
			this.startStep(workflow);
		} else {
			// Spec workflows run the Artifacts step between the review loop
			// and PR creation. Quick-fix / epic orders don't contain the
			// implement-review step, so this branch is only ever hit for specs.
			workflow.currentStepIndex = this.requireStepIndex(workflow, STEP.ARTIFACTS);
			this.startStep(workflow);
		}
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
	 * to a terminal state (completed/aborted/error) AND that state MUST have
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
		// onComplete broadcasts the terminal state from the in-memory orchestrator
		// and removes it from the active map. A subsequent onStateChange would race
		// the async `persistWorkflow` save above: broadcastPersistedWorkflowState
		// falls back to disk and can re-broadcast a pre-completion state, leaving
		// the UI stuck on the prior step. Let onComplete own the final broadcast.
		this.callbacks.onComplete(workflow.id);

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
				if (w.status === "error" || w.status === "aborted") errorIds.add(w.id);
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
		const terminal = (s: WorkflowStatus) => s === "completed" || s === "error" || s === "aborted";
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

		// Artifacts: translate a timer-induced kill into the timeout reason so
		// the UI and audit log show "timeout" rather than the raw CLI exit
		// message. Non-timeout errors (LLM non-zero exit, spawn failure) keep
		// their original message and log as `llm-error`.
		if (step.name === STEP.ARTIFACTS) {
			const artifactsState = this.clearArtifactsTimer(workflowId);
			const timedOut = artifactsState?.timedOut === true;
			// Salvage: the CLI can be killed (idle timeout, wall-clock timeout,
			// or a non-zero exit) AFTER the agent already wrote a complete
			// manifest and all listed files. Retrying in that state loops
			// because the agent correctly reports "already done" and emits no
			// fresh tool activity, tripping the idle timer again. If a valid
			// manifest is on disk, finish the step from it instead of erroring.
			if (artifactsState) {
				const salvaged = collectArtifactsFromManifest(workflow, artifactsState.outputDir, {
					perFileMaxBytes: artifactsState.perFileMaxBytes,
					perStepMaxBytes: artifactsState.perStepMaxBytes,
				});
				// Only suppress the CLI error if we actually recovered files. An
				// "empty" outcome on a failed CLI run means the agent died before
				// producing anything — surface the original error so the user
				// knows the step did not really succeed.
				if (salvaged.outcome === "with-files") {
					logger.warn(
						`[artifacts] Recovered from CLI error for workflow ${workflowId} (timedOut=${timedOut}): ${error}`,
					);
					this.handleStepOutput(
						workflowId,
						`[artifacts] CLI terminated (${timedOut ? "timeout" : "error"}: ${error}) — salvaged ${salvaged.accepted.length} file(s) from the output directory`,
					);
					this.finishArtifactsStep(workflow, salvaged);
					return;
				}
			}
			const finalMessage = timedOut
				? `Artifacts step exceeded wall-clock timeout (${configStore.get().timing.artifactsTimeoutMs}ms)`
				: error;
			this.auditArtifactsEnd(workflowId, "error", {
				reason: timedOut ? `timeout: ${finalMessage}` : `llm-error: ${error}`,
			});
			step.outcome = null;
			error = finalMessage;
		}

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
			this.applyCiFlowOutcome(workflow, this.ciMergeFlow.routeToMergePrPause());
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
		this.markQuestionAlertSeen(workflowId);

		this.flushPersistDebounce();
		this.persistWorkflow(workflow);
		this.callbacks.onError(workflowId, error);
		this.callbacks.onStateChange(workflowId);

		// Do NOT release the managed-repo refcount here. Error is a retriable
		// state — the user can click "Retry step" and we re-enter the spawn path
		// at the same worktree. If we released now and this workflow held the
		// last ref, the clone would be deleted and retry would fail with a
		// missing-cwd error. Release happens on `completeWorkflow` and `abort`,
		// which are the only truly terminal transitions for a URL-sourced
		// workflow. Cleanup of stuck-in-error workflows is handled by explicit
		// user action (abort) or purge.

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

	private markQuestionAlertSeen(workflowId: string): void {
		this.callbacks.onAlertMarkSeenWhere?.(
			(a) => a.type === "question-asked" && a.workflowId === workflowId,
		);
	}

	private persistWorkflow(workflow: Workflow): void {
		this.store.save(workflow).catch((err) => {
			logger.error(`[pipeline] Failed to persist workflow: ${err}`);
		});
	}

	/** Reset question detector state between steps. */
	private resetStepState(): void {
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
			onTools: (tools) => this.handleStepTools(workflowId, tools),
			onAssistantMessage: (_wfId, text) => this.questionDetector.appendFinalizedMessage(text),
		});
	}

	private handleStepTools(workflowId: string, tools: ToolUsage[]): void {
		const workflow = this.getActiveWorkflow(workflowId);
		if (workflow) {
			const step = workflow.steps[workflow.currentStepIndex];
			step.outputLog.push({ kind: "tools", tools });
			workflow.updatedAt = new Date().toISOString();
			this.persistDebounced(workflow);
		}
		this.callbacks.onTools(workflowId, tools);
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
