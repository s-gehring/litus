import { AuditLogger } from "./audit-logger";
import { buildFixPrompt, gatherAllFailureLogs } from "./ci-fixer";
import { allFailuresCancelled, type MonitorResult, startMonitoring } from "./ci-monitor";
import type { CLICallbacks } from "./cli-runner";
import { CLIRunner } from "./cli-runner";
import { computeDependencyStatus } from "./dependency-resolver";
import {
	mergePr as defaultMergePr,
	resolveConflicts as defaultResolveConflicts,
} from "./pr-merger";
import { QuestionDetector } from "./question-detector";
import { syncRepo as defaultSyncRepo } from "./repo-syncer";
import { ReviewClassifier } from "./review-classifier";
import { Summarizer } from "./summarizer";
import type { PipelineStepName, Question, Workflow } from "./types";
import { WorkflowEngine } from "./workflow-engine";
import { WorkflowStore } from "./workflow-store";

export interface PipelineCallbacks {
	onStepChange: (
		workflowId: string,
		previousStep: PipelineStepName | null,
		currentStep: PipelineStepName,
		currentStepIndex: number,
		reviewIteration: number,
	) => void;
	onOutput: (workflowId: string, text: string) => void;
	onTools: (workflowId: string, tools: Record<string, number>) => void;
	onComplete: (workflowId: string) => void;
	onError: (workflowId: string, error: string) => void;
	onStateChange: (workflowId: string) => void;
	onEpicDependencyUpdate?: (
		dependentWorkflowId: string,
		status: import("./types").EpicDependencyStatus,
		blockingWorkflows: string[],
	) => void;
}

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
}

const PR_URL_PATTERN = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/g;

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
		this.callbacks = callbacks;
	}

	getEngine(): WorkflowEngine {
		return this.engine;
	}

	/** Start the pipeline for an already-created workflow (used by epic flow). */
	startPipelineFromWorkflow(workflow: Workflow): void {
		this.engine.setWorkflow(workflow);
		this.engine.transition(workflow.id, "running");

		const branchCwd = workflow.targetRepository || process.cwd();
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

	async startPipeline(specification: string, targetRepository?: string): Promise<Workflow> {
		const workflow = await this.engine.createWorkflow(specification, targetRepository);
		this.engine.transition(workflow.id, "running");

		const branchCwd = targetRepository || process.cwd();
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
			const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const code = await proc.exited;
			if (code !== 0) return null;
			const text = await new Response(proc.stdout as ReadableStream).text();
			return text.trim() || null;
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

		if (step.name === "monitor-ci") {
			if (answer.toLowerCase().includes("abort")) {
				this.handleStepError(workflowId, "Workflow aborted by user after cancelled CI checks");
			} else {
				this.runMonitorCi(workflow);
			}
			return;
		}

		this.questionDetector.reset();
		this.cliRunner.sendAnswer(workflowId, answer);
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
		if (step.name !== "monitor-ci") return;

		this.runMonitorCi(workflow);
	}

	async resumeStep(workflowId: string): Promise<void> {
		const workflow = this.getWorkflowOrThrow(workflowId);
		if (workflow.status !== "running") return;

		const step = workflow.steps[workflow.currentStepIndex];
		if (!step.sessionId) return;

		const cwd = workflow.worktreePath || process.cwd();
		const pipelineName =
			this.pipelineName ?? (await this.getBranch(process.cwd())) ?? workflow.worktreeBranch;
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

		this.cliRunner.resume(workflowId, step.sessionId, cwd, cliCallbacks);
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

		const cwd = workflow.worktreePath || process.cwd();
		const pipelineName =
			this.pipelineName ?? (await this.getBranch(process.cwd())) ?? workflow.worktreeBranch;
		this.currentAuditRunId = this.auditLogger.startRun(pipelineName, workflow.worktreeBranch);

		this.engine.transition(workflowId, "running");
		this.callbacks.onStateChange(workflowId);
		this.assistantTextBuffer = "";
		this.questionDetector.reset();

		this.runStep(workflow, step.prompt, cwd);
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

		const cwd = workflow.worktreePath || process.cwd();

		if (step.name === "monitor-ci") {
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
			this.cliRunner.resume(workflowId, step.sessionId, cwd, cliCallbacks);
		} else {
			this.runStep(workflow, step.prompt, cwd);
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

		if (step.name === "monitor-ci") {
			this.runMonitorCi(workflow);
			return;
		}

		if (step.name === "fix-ci") {
			this.runFixCi(workflow);
			return;
		}

		if (step.name === "merge-pr") {
			this.runMergePr(workflow);
			return;
		}

		if (step.name === "sync-repo") {
			this.runSyncRepo(workflow);
			return;
		}

		const cwd = workflow.worktreePath || process.cwd();
		this.runStep(workflow, step.prompt, cwd);
	}

	private runMonitorCi(workflow: Workflow): void {
		if (!workflow.prUrl) {
			this.handleStepError(workflow.id, "No PR URL found — cannot monitor CI checks");
			return;
		}

		workflow.ciCycle.monitorStartedAt =
			workflow.ciCycle.monitorStartedAt ?? new Date().toISOString();
		this.persistWorkflow(workflow);

		this.monitorAbortController = new AbortController();

		startMonitoring(
			workflow.prUrl,
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

	private handleMonitorResult(workflowId: string, result: MonitorResult): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return;

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

				const cwd = workflow.worktreePath || process.cwd();
				this.runStep(workflow, prompt, cwd);
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

		const fixCiIndex = workflow.steps.findIndex((s) => s.name === "fix-ci");
		workflow.currentStepIndex = fixCiIndex;
		this.startStep(workflow);
	}

	private runStep(workflow: Workflow, prompt: string, cwd: string): void {
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

		this.cliRunner.start(stepWorkflow, cliCallbacks);
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

		if (step.name === "commit-push-pr") {
			const url = extractPrUrl(step.output);
			if (url) workflow.prUrl = url;
		}

		this.flushPersistDebounce(workflow);
		this.persistWorkflow(workflow);

		// After commit-push-pr completes, route to monitor-ci
		if (step.name === "commit-push-pr") {
			const monitorIndex = workflow.steps.findIndex((s) => s.name === "monitor-ci");
			workflow.currentStepIndex = monitorIndex;
			this.startStep(workflow);
			return;
		}

		// After monitor-ci passes, route to merge-pr
		if (step.name === "monitor-ci") {
			const mergePrIndex = workflow.steps.findIndex((s) => s.name === "merge-pr");
			workflow.currentStepIndex = mergePrIndex;
			this.startStep(workflow);
			return;
		}

		// After fix-ci completes, increment attempt and loop back to monitor-ci
		if (step.name === "fix-ci") {
			this.routeBackToMonitor(workflow);
			return;
		}

		// After merge-pr succeeds, route to sync-repo
		if (step.name === "merge-pr") {
			const syncRepoIndex = workflow.steps.findIndex((s) => s.name === "sync-repo");
			workflow.currentStepIndex = syncRepoIndex;
			this.startStep(workflow);
			return;
		}

		// After sync-repo completes, finish the workflow
		if (step.name === "sync-repo") {
			this.completeWorkflow(workflow);
			return;
		}

		// After review completes, ALWAYS route to implement-review
		if (step.name === "review") {
			this.routeToImplementReview(workflow);
			return;
		}

		// After implement-review completes, classify and decide: loop or advance
		if (step.name === "implement-review") {
			this.handleImplementReviewComplete(workflow).catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[pipeline] Implement-review completion error: ${msg}`);
				this.handleStepError(workflowId, msg);
			});
			return;
		}

		this.advanceToNextStep(workflow);
	}

	private routeToImplementReview(workflow: Workflow): void {
		workflow.reviewCycle.iteration++;

		const implReviewIndex = workflow.steps.findIndex((s) => s.name === "implement-review");

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
		const reviewIndex = workflow.steps.findIndex((s) => s.name === "review");
		const reviewStep = workflow.steps[reviewIndex];
		const severity = await this.reviewClassifier.classify(reviewStep.output);

		workflow.reviewCycle.lastSeverity = severity;
		workflow.updatedAt = new Date().toISOString();

		const shouldLoop =
			(severity === "critical" || severity === "major") &&
			workflow.reviewCycle.iteration < workflow.reviewCycle.maxIterations;

		if (shouldLoop) {
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
			workflow.currentStepIndex = workflow.steps.findIndex((s) => s.name === "commit-push-pr");
			this.startStep(workflow);
		}
	}

	private routeBackToMonitor(workflow: Workflow): void {
		workflow.ciCycle.attempt++;
		workflow.ciCycle.monitorStartedAt = null;
		workflow.ciCycle.failureLogs = [];

		const monitorIndex = workflow.steps.findIndex((s) => s.name === "monitor-ci");
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

		const cwd = workflow.worktreePath || process.cwd();

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
			const cwd = workflow.worktreePath || process.cwd();
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
		const targetRepo = workflow.targetRepository || process.cwd();

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
