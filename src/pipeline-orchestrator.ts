import { AuditLogger } from "./audit-logger";
import type { CLICallbacks } from "./cli-runner";
import { CLIRunner } from "./cli-runner";
import { QuestionDetector } from "./question-detector";
import { ReviewClassifier } from "./review-classifier";
import { Summarizer } from "./summarizer";
import type { PipelineStepName, Workflow } from "./types";
import { WorkflowEngine } from "./workflow-engine";

export interface PipelineCallbacks {
	onStepChange: (
		workflowId: string,
		previousStep: PipelineStepName | null,
		currentStep: PipelineStepName,
		currentStepIndex: number,
		reviewIteration: number,
	) => void;
	onOutput: (workflowId: string, text: string) => void;
	onComplete: (workflowId: string) => void;
	onError: (workflowId: string, error: string) => void;
	onStateChange: (workflowId: string) => void;
}

export interface PipelineDeps {
	engine?: WorkflowEngine;
	cliRunner?: CLIRunner;
	questionDetector?: QuestionDetector;
	reviewClassifier?: ReviewClassifier;
	summarizer?: Summarizer;
	auditLogger?: AuditLogger;
}

export class PipelineOrchestrator {
	private engine: WorkflowEngine;
	private cliRunner: CLIRunner;
	private questionDetector: QuestionDetector;
	private reviewClassifier: ReviewClassifier;
	private summarizer: Summarizer;
	private auditLogger: AuditLogger;
	private callbacks: PipelineCallbacks;
	private assistantTextBuffer = "";
	private currentAuditRunId: string | null = null;
	private pipelineName: string | null = null;

	constructor(callbacks: PipelineCallbacks, deps?: PipelineDeps) {
		this.engine = deps?.engine ?? new WorkflowEngine();
		this.cliRunner = deps?.cliRunner ?? new CLIRunner();
		this.questionDetector = deps?.questionDetector ?? new QuestionDetector();
		this.reviewClassifier = deps?.reviewClassifier ?? new ReviewClassifier();
		this.summarizer = deps?.summarizer ?? new Summarizer();
		this.auditLogger = deps?.auditLogger ?? new AuditLogger();
		this.callbacks = callbacks;
	}

	getEngine(): WorkflowEngine {
		return this.engine;
	}

	async startPipeline(
		specification: string,
		targetRepository?: string,
	): Promise<Workflow> {
		const workflow = await this.engine.createWorkflow(specification, targetRepository);
		this.engine.transition(workflow.id, "running");

		const branchCwd = targetRepository || process.cwd();
		this.pipelineName = (await this.getBranch(branchCwd)) ?? workflow.worktreeBranch;
		this.currentAuditRunId = this.auditLogger.startRun(this.pipelineName, workflow.worktreeBranch);

		this.startStep(workflow);

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

		this.callbacks.onStateChange(workflowId);
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

	cancelPipeline(workflowId: string): void {
		const workflow = this.getWorkflowOrThrow(workflowId);

		if (this.currentAuditRunId) {
			this.auditLogger.endRun(this.currentAuditRunId, { cancelled: true });
			this.currentAuditRunId = null;
		}

		this.cliRunner.kill(workflowId);
		this.summarizer.cleanup(workflowId);
		this.questionDetector.reset();
		this.assistantTextBuffer = "";

		const step = workflow.steps[workflow.currentStepIndex];
		if (step.status === "running" || step.status === "waiting_for_input") {
			step.status = "error";
			step.error = "Cancelled by user";
		}

		try {
			this.engine.transition(workflowId, "cancelled");
		} catch (e) {
			if (e instanceof Error && !e.message.includes("Invalid transition")) throw e;
			else console.warn(`[pipeline] Suppressed transition error: ${e}`);
		}

		this.callbacks.onStateChange(workflowId);
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
		workflow.updatedAt = new Date().toISOString();

		this.assistantTextBuffer = "";
		this.questionDetector.reset();

		this.callbacks.onStepChange(
			workflow.id,
			previousStep,
			step.name,
			workflow.currentStepIndex,
			workflow.reviewCycle.iteration,
		);
		this.callbacks.onStateChange(workflow.id);

		const cwd = workflow.worktreePath || process.cwd();
		this.runStep(workflow, step.prompt, cwd);
	}

	private runStep(workflow: Workflow, prompt: string, cwd: string): void {
		const stepWorkflow: Workflow = {
			...workflow,
			specification: prompt,
			worktreePath: cwd,
		};

		const cliCallbacks: CLICallbacks = {
			onOutput: (text) => this.handleStepOutput(workflow.id, text),
			onComplete: () => this.handleStepComplete(workflow.id),
			onError: (error) => this.handleStepError(workflow.id, error),
			onSessionId: (sessionId) => this.handleSessionId(workflow.id, sessionId),
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

		this.assistantTextBuffer += `${text}\n`;

		this.summarizer.maybeSummarize(workflowId, text, (summary) => {
			try {
				this.engine.updateSummary(workflowId, summary);
				this.callbacks.onStateChange(workflowId);
			} catch (e) {
				if (e instanceof Error && !e.message.includes("not found")) throw e;
			}
		});
	}

	private handleStepComplete(workflowId: string): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return;

		const question = this.questionDetector.detect(this.assistantTextBuffer);
		if (question) {
			if (question.confidence === "uncertain") {
				this.questionDetector
					.classifyWithHaiku(question.content)
					.then((isQuestion) => {
						if (!isQuestion) {
							this.advanceAfterStep(workflowId);
							return;
						}
						this.pauseForQuestion(workflowId, question);
					})
					.catch(() => {
						this.advanceAfterStep(workflowId);
					});
			} else {
				this.pauseForQuestion(workflowId, question);
			}
		} else {
			this.advanceAfterStep(workflowId);
		}
	}

	private pauseForQuestion(
		workflowId: string,
		question: {
			id: string;
			content: string;
			confidence: "certain" | "uncertain";
			detectedAt: string;
		},
	): void {
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

		this.callbacks.onStateChange(workflowId);
	}

	private advanceAfterStep(workflowId: string): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.status = "completed";
		step.completedAt = new Date().toISOString();
		workflow.updatedAt = new Date().toISOString();

		if (step.name === "review") {
			this.handleReviewComplete(workflow).catch((err) =>
				this.handleStepError(workflowId, err instanceof Error ? err.message : String(err)),
			);
			return;
		}

		// After implement-review completes during a re-cycle, route back to review
		if (step.name === "implement-review" && workflow.reviewCycle.iteration > 1) {
			const reviewIndex = workflow.steps.findIndex((s) => s.name === "review");
			if (reviewIndex >= 0 && workflow.steps[reviewIndex].status === "pending") {
				workflow.currentStepIndex = reviewIndex;
				this.startStep(workflow);
				return;
			}
		}

		this.advanceToNextStep(workflow);
	}

	private async handleReviewComplete(workflow: Workflow): Promise<void> {
		const reviewStep = workflow.steps[workflow.currentStepIndex];
		const severity = await this.reviewClassifier.classify(reviewStep.output);

		workflow.reviewCycle.lastSeverity = severity;
		workflow.updatedAt = new Date().toISOString();

		const shouldReCycle =
			(severity === "critical" || severity === "major") &&
			workflow.reviewCycle.iteration < workflow.reviewCycle.maxIterations;

		if (shouldReCycle) {
			workflow.reviewCycle.iteration++;

			const reviewIndex = workflow.steps.findIndex((s) => s.name === "review");
			const implReviewIndex = workflow.steps.findIndex((s) => s.name === "implement-review");

			for (const idx of [implReviewIndex, reviewIndex]) {
				workflow.steps[idx].status = "pending";
				workflow.steps[idx].output = "";
				workflow.steps[idx].error = null;
				workflow.steps[idx].sessionId = null;
				workflow.steps[idx].startedAt = null;
				workflow.steps[idx].completedAt = null;
			}

			workflow.currentStepIndex = implReviewIndex;
			this.startStep(workflow);
		} else {
			const commitIndex = workflow.steps.findIndex((s) => s.name === "commit-push-pr");
			workflow.currentStepIndex = commitIndex;
			this.startStep(workflow);
		}
	}

	private advanceToNextStep(workflow: Workflow): void {
		const nextIndex = workflow.currentStepIndex + 1;

		if (nextIndex >= workflow.steps.length) {
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
			this.callbacks.onComplete(workflow.id);
			this.callbacks.onStateChange(workflow.id);
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
		workflow.updatedAt = new Date().toISOString();

		try {
			this.engine.transition(workflowId, "error");
		} catch (e) {
			if (e instanceof Error && !e.message.includes("Invalid transition")) throw e;
			else console.warn(`[pipeline] Suppressed transition error: ${e}`);
		}

		this.callbacks.onError(workflowId, error);
		this.callbacks.onStateChange(workflowId);
	}

	private handleSessionId(workflowId: string, sessionId: string): void {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) return;

		const step = workflow.steps[workflow.currentStepIndex];
		step.sessionId = sessionId;
	}

	private getWorkflowOrThrow(workflowId: string): Workflow {
		const workflow = this.engine.getWorkflow();
		if (!workflow || workflow.id !== workflowId) {
			throw new Error(`Workflow ${workflowId} not found`);
		}
		return workflow;
	}
}
