import type { CLICallbacks, CLIRunner } from "./cli-runner";
import type {
	EffortLevel,
	PipelineStep,
	PipelineStepRun,
	PipelineStepStatus,
	ToolUsage,
	Workflow,
} from "./types";

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
		callbacks: CLICallbacks,
		extraEnv?: Record<string, string>,
		model?: string,
		effort?: EffortLevel,
	): void {
		this.cliRunner.start(workflow, callbacks, extraEnv, model, effort);
	}

	resumeStep(
		workflowId: string,
		sessionId: string,
		cwd: string,
		callbacks: CLICallbacks,
		extraEnv?: Record<string, string>,
		prompt?: string,
		model?: string,
		effort?: EffortLevel,
	): void {
		this.cliRunner.resume(workflowId, sessionId, cwd, callbacks, extraEnv, prompt, model, effort);
	}

	killProcess(workflowId: string): void {
		this.cliRunner.kill(workflowId);
	}
}
