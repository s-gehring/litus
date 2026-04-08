import type { CLICallbacks, CLIRunner } from "./cli-runner";
import type { EffortLevel, PipelineStep, ToolUsage, Workflow } from "./types";

export interface StepCallbackHandlers {
	onOutput: (workflowId: string, text: string) => void;
	onComplete: (workflowId: string) => void;
	onError: (workflowId: string, error: string) => void;
	onSessionId: (workflowId: string, sessionId: string) => void;
	onPid: (workflowId: string, pid: number) => void;
	onTools: (tools: ToolUsage[]) => void;
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
		};
	}

	resetStep(step: PipelineStep, status: "running" | "pending" = "running"): void {
		step.status = status;
		step.startedAt = status === "running" ? new Date().toISOString() : null;
		step.output = "";
		step.error = null;
		step.sessionId = null;
		step.pid = null;
		step.completedAt = null;
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
	): void {
		this.cliRunner.resume(workflowId, sessionId, cwd, callbacks, extraEnv, prompt);
	}

	killProcess(workflowId: string): void {
		this.cliRunner.kill(workflowId);
	}
}
