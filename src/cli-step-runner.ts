import type { CLICallbacks, CLIRunner } from "./cli-runner";
import type { EffortLevel } from "./config-types";
import type { PipelineStep, PipelineStepRun, PipelineStepStatus } from "./pipeline-steps";
import type { ToolUsage, Workflow } from "./types";

/**
 * Branded token witnessing that `workflow.activeInvocation` has been refreshed
 * for an imminent LLM dispatch. The only way to obtain one — without an
 * explicit `as` cast — is via `prepareLlmDispatch`, which mutates
 * `activeInvocation` atomically.
 *
 * `CLIStepRunner.startStep` / `resumeStep` accept this token in lieu of free
 * `model`/`effort` arguments, so the type system rejects any dispatch path
 * that forgot to update the active invocation (e.g. answering a question
 * without refreshing the model the UI displays).
 *
 * The brand uses a private compile-time-only field; the runtime payload only
 * carries `model` and `effort`.
 */
export interface LlmDispatchPermit {
	readonly __llmDispatchPermitBrand: never;
	readonly model: string | undefined;
	readonly effort: EffortLevel | undefined;
}

/**
 * Refresh `workflow.activeInvocation` for an imminent main-step LLM dispatch
 * and return the permit consumed by `CLIStepRunner.startStep` / `resumeStep`.
 * The mutation is intentionally synchronous so the caller can persist+broadcast
 * the workflow before the CLI process is spawned.
 */
export function prepareLlmDispatch(
	workflow: Workflow,
	step: PipelineStep,
	model: string | undefined,
	effort: EffortLevel | undefined,
): LlmDispatchPermit {
	const now = new Date().toISOString();
	workflow.activeInvocation = {
		model: model ?? "",
		effort: effort ?? null,
		stepName: step.name,
		startedAt: now,
		role: "main",
	};
	workflow.updatedAt = now;
	return { model, effort } as unknown as LlmDispatchPermit;
}

// Map a live step's status to the subset allowed in an archived `PipelineStepRun`.
// Exhaustive switch surfaces future additions to `PipelineStepStatus` at the
// schema-change site.
function archivedStatusFor(status: PipelineStepStatus): PipelineStepRun["status"] {
	switch (status) {
		case "completed":
		case "error":
			return status;
		case "pending":
		case "running":
		case "waiting_for_input":
		case "paused":
			return "paused";
	}
}

// Archive the prior run (if any) and reset the live fields to a clean state.
// Shared by `CLIStepRunner.resetStep` and `recoverInterruptedFeedbackImplementer`
// so every archive path goes through one codepath (research.md R1).
export function archiveAndResetStep(
	step: PipelineStep,
	status: "running" | "pending" = "running",
): void {
	if (step.startedAt !== null) {
		const run: PipelineStepRun = {
			runNumber: step.history.length + 1,
			status: archivedStatusFor(step.status),
			output: step.output,
			outputLog: step.outputLog,
			error: step.error,
			startedAt: step.startedAt,
			completedAt: step.completedAt,
		};
		step.history.push(run);
	}
	step.status = status;
	step.startedAt = status === "running" ? new Date().toISOString() : null;
	step.output = "";
	step.outputLog = [];
	step.error = null;
	step.sessionId = null;
	step.pid = null;
	step.completedAt = null;
}

export interface StepCallbackHandlers {
	onOutput: (workflowId: string, text: string) => void;
	onComplete: (workflowId: string) => void;
	onError: (workflowId: string, error: string) => void;
	onSessionId: (workflowId: string, sessionId: string) => void;
	onPid: (workflowId: string, pid: number) => void;
	onTools: (tools: ToolUsage[]) => void;
	onAssistantMessage?: (workflowId: string, text: string) => void;
}

export class CLIStepRunner {
	private cliRunner: CLIRunner;

	constructor(cliRunner: CLIRunner) {
		this.cliRunner = cliRunner;
	}

	buildCallbacks(workflowId: string, handlers: StepCallbackHandlers): CLICallbacks {
		return {
			onOutput: (text) => handlers.onOutput(workflowId, text),
			onTools: (tools) => handlers.onTools(tools),
			onComplete: () => handlers.onComplete(workflowId),
			onError: (error) => handlers.onError(workflowId, error),
			onSessionId: (sessionId) => handlers.onSessionId(workflowId, sessionId),
			onPid: (pid) => handlers.onPid(workflowId, pid),
			onAssistantMessage: handlers.onAssistantMessage
				? (text) => handlers.onAssistantMessage?.(workflowId, text)
				: undefined,
		};
	}

	resetStep(step: PipelineStep, status: "running" | "pending" = "running"): void {
		archiveAndResetStep(step, status);
	}

	startStep(
		workflow: Workflow,
		permit: LlmDispatchPermit,
		callbacks: CLICallbacks,
		extraEnv?: Record<string, string>,
	): void {
		this.cliRunner.start(workflow, callbacks, extraEnv, permit.model, permit.effort);
	}

	resumeStep(
		workflowId: string,
		sessionId: string,
		cwd: string,
		permit: LlmDispatchPermit,
		callbacks: CLICallbacks,
		extraEnv?: Record<string, string>,
		prompt?: string,
	): void {
		this.cliRunner.resume(
			workflowId,
			sessionId,
			cwd,
			callbacks,
			extraEnv,
			prompt,
			permit.model,
			permit.effort,
		);
	}

	killProcess(workflowId: string): void {
		this.cliRunner.kill(workflowId);
	}
}
