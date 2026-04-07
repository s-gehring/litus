import type { CLICallbacks } from "../../src/cli-runner";
import type { ToolUsage } from "../../src/types";
import { type CallTracker, createCallTracker } from "./call-tracker";

export interface MockCliRunner {
	mock: {
		start: (workflowId: string, prompt: string, callbacks: CLICallbacks, opts?: object) => void;
		resume: (workflowId: string, input: string, callbacks: CLICallbacks, opts?: object) => void;
		kill: (workflowId: string) => void;
		killAll: () => void;
	};
	tracker: CallTracker;
	emitOutput: (text: string) => void;
	emitTools: (tools: ToolUsage[]) => void;
	emitComplete: () => void;
	emitError: (error: string) => void;
	emitSessionId: (id: string) => void;
	emitPid: (pid: number) => void;
}

/** Create a mock CLI runner with call tracking and callback triggers */
export function createMockCliRunner(): MockCliRunner {
	const tracker = createCallTracker();
	let lastCallbacks: CLICallbacks | null = null;

	const mock = {
		start(workflowId: string, prompt: string, callbacks: CLICallbacks, opts?: object): void {
			lastCallbacks = callbacks;
			tracker.calls.push({
				method: "start",
				args: [workflowId, prompt, callbacks, opts],
			});
		},
		resume(workflowId: string, input: string, callbacks: CLICallbacks, opts?: object): void {
			lastCallbacks = callbacks;
			tracker.calls.push({
				method: "resume",
				args: [workflowId, input, callbacks, opts],
			});
		},
		kill(workflowId: string): void {
			tracker.calls.push({ method: "kill", args: [workflowId] });
		},
		killAll(): void {
			tracker.calls.push({ method: "killAll", args: [] });
		},
	};

	return {
		mock,
		tracker,
		emitOutput(text: string): void {
			lastCallbacks?.onOutput(text);
		},
		emitTools(tools: ToolUsage[]): void {
			lastCallbacks?.onTools(tools);
		},
		emitComplete(): void {
			lastCallbacks?.onComplete();
		},
		emitError(error: string): void {
			lastCallbacks?.onError(error);
		},
		emitSessionId(id: string): void {
			lastCallbacks?.onSessionId(id);
		},
		emitPid(pid: number): void {
			lastCallbacks?.onPid?.(pid);
		},
	};
}
