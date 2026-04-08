import { describe, expect, mock, test } from "bun:test";
import type { CLICallbacks, CLIRunner } from "../../src/cli-runner";
import { CLIStepRunner, type StepCallbackHandlers } from "../../src/cli-step-runner";
import type { Workflow } from "../../src/types";
import { makePipelineStep } from "../test-infra";

function makeHandlers(): StepCallbackHandlers {
	return {
		onOutput: mock(() => {}),
		onComplete: mock(() => {}),
		onError: mock(() => {}),
		onSessionId: mock(() => {}),
		onPid: mock(() => {}),
		onTools: mock(() => {}),
	};
}

function makeMockCLIRunner(): Pick<CLIRunner, "start" | "resume" | "kill"> {
	return {
		start: mock(() => {}),
		resume: mock(() => {}),
		kill: mock(() => {}),
	};
}

// ── buildCallbacks ─────────────────────────────────────────

describe("buildCallbacks", () => {
	test("produces CLICallbacks with all required handler mappings", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const handlers = makeHandlers();
		const cb = runner.buildCallbacks("wf-1", handlers);

		expect(cb).toBeDefined();
		expect(typeof cb.onOutput).toBe("function");
		expect(typeof cb.onTools).toBe("function");
		expect(typeof cb.onComplete).toBe("function");
		expect(typeof cb.onError).toBe("function");
		expect(typeof cb.onSessionId).toBe("function");
		expect(typeof cb.onPid).toBe("function");
	});

	test("delegates onOutput to handler with workflowId", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const handlers = makeHandlers();
		const cb = runner.buildCallbacks("wf-1", handlers);

		cb.onOutput("hello");
		expect(handlers.onOutput).toHaveBeenCalledWith("wf-1", "hello");
	});

	test("delegates onComplete to handler with workflowId", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const handlers = makeHandlers();
		const cb = runner.buildCallbacks("wf-1", handlers);

		cb.onComplete();
		expect(handlers.onComplete).toHaveBeenCalledWith("wf-1");
	});

	test("delegates onError to handler with workflowId", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const handlers = makeHandlers();
		const cb = runner.buildCallbacks("wf-1", handlers);

		cb.onError("boom");
		expect(handlers.onError).toHaveBeenCalledWith("wf-1", "boom");
	});

	test("delegates onSessionId to handler with workflowId", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const handlers = makeHandlers();
		const cb = runner.buildCallbacks("wf-1", handlers);

		cb.onSessionId("sess-123");
		expect(handlers.onSessionId).toHaveBeenCalledWith("wf-1", "sess-123");
	});

	test("delegates onPid to handler with workflowId", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const handlers = makeHandlers();
		const cb = runner.buildCallbacks("wf-1", handlers);

		cb.onPid?.(42);
		expect(handlers.onPid).toHaveBeenCalledWith("wf-1", 42);
	});

	test("delegates onTools to handler with tools array", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const handlers = makeHandlers();
		const cb = runner.buildCallbacks("wf-1", handlers);

		const tools = [{ name: "Read" }];
		cb.onTools(tools);
		expect(handlers.onTools).toHaveBeenCalledWith(tools);
	});
});

// ── resetStep ──────────────────────────────────────────────

describe("resetStep", () => {
	test("sets status to running", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const step = makePipelineStep({ status: "error" });

		runner.resetStep(step);
		expect(step.status).toBe("running");
	});

	test("clears output", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const step = makePipelineStep({ output: "old output" });

		runner.resetStep(step);
		expect(step.output).toBe("");
	});

	test("clears error", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const step = makePipelineStep({ error: "old error" });

		runner.resetStep(step);
		expect(step.error).toBeNull();
	});

	test("clears sessionId", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const step = makePipelineStep({ sessionId: "sess-old" });

		runner.resetStep(step);
		expect(step.sessionId).toBeNull();
	});

	test("clears pid", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const step = makePipelineStep({ pid: 123 });

		runner.resetStep(step);
		expect(step.pid).toBeNull();
	});

	test("sets startedAt to current time", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const step = makePipelineStep({ startedAt: null });

		const before = new Date().toISOString();
		runner.resetStep(step);
		const after = new Date().toISOString();

		expect(step.startedAt).not.toBeNull();
		expect((step.startedAt as string) >= before).toBe(true);
		expect((step.startedAt as string) <= after).toBe(true);
	});

	test("clears completedAt", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const step = makePipelineStep({ completedAt: new Date().toISOString() });

		runner.resetStep(step);
		expect(step.completedAt).toBeNull();
	});
});

// ── startStep / resumeStep / killProcess ───────────────────

describe("startStep", () => {
	test("delegates to cliRunner.start", () => {
		const cliRunner = makeMockCLIRunner();
		const runner = new CLIStepRunner(cliRunner as CLIRunner);
		const workflow = { id: "wf-1" } as Workflow;
		const callbacks = {} as CLICallbacks;
		const env = { FOO: "bar" };

		runner.startStep(workflow, callbacks, env, "sonnet", "high");
		expect(cliRunner.start).toHaveBeenCalledWith(workflow, callbacks, env, "sonnet", "high");
	});
});

describe("resumeStep", () => {
	test("delegates to cliRunner.resume", () => {
		const cliRunner = makeMockCLIRunner();
		const runner = new CLIStepRunner(cliRunner as CLIRunner);
		const callbacks = {} as CLICallbacks;
		const env = { FOO: "bar" };

		runner.resumeStep("wf-1", "sess-1", "/cwd", callbacks, env, "my answer");
		expect(cliRunner.resume).toHaveBeenCalledWith(
			"wf-1",
			"sess-1",
			"/cwd",
			callbacks,
			env,
			"my answer",
		);
	});
});

describe("killProcess", () => {
	test("delegates to cliRunner.kill", () => {
		const cliRunner = makeMockCLIRunner();
		const runner = new CLIStepRunner(cliRunner as CLIRunner);

		runner.killProcess("wf-1");
		expect(cliRunner.kill).toHaveBeenCalledWith("wf-1");
	});
});
