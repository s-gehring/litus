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
		expect(handlers.onOutput).toHaveBeenCalledWith("wf-1", "hello", undefined);
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

	test("sets status to pending when requested", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const step = makePipelineStep({ status: "completed" });

		runner.resetStep(step, "pending");
		expect(step.status).toBe("pending");
	});

	test("sets startedAt to null when status is pending", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const step = makePipelineStep({ startedAt: new Date().toISOString() });

		runner.resetStep(step, "pending");
		expect(step.startedAt).toBeNull();
	});

	test("archives prior run into history when step previously ran", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const startedAt = "2026-04-18T12:00:00.000Z";
		const completedAt = "2026-04-18T12:05:00.000Z";
		const step = makePipelineStep({
			status: "completed",
			output: "first run output",
			error: null,
			startedAt,
			completedAt,
		});

		runner.resetStep(step, "pending");
		expect(step.history).toHaveLength(1);
		expect(step.history[0]).toEqual({
			runNumber: 1,
			status: "completed",
			output: "first run output",
			outputLog: [],
			error: null,
			startedAt,
			completedAt,
		});
		expect(step.output).toBe("");
		expect(step.outputLog).toEqual([]);
		expect(step.error).toBeNull();
		expect(step.startedAt).toBeNull();
		expect(step.completedAt).toBeNull();
	});

	test("does not archive when step never ran (startedAt === null)", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const step = makePipelineStep({ status: "pending", startedAt: null });

		runner.resetStep(step);
		expect(step.history).toHaveLength(0);
	});

	test("maps non-terminal live status to 'paused' when archiving", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const step = makePipelineStep({
			status: "running",
			output: "partial",
			startedAt: "2026-04-18T12:00:00.000Z",
		});

		runner.resetStep(step, "pending");
		expect(step.history[0].status).toBe("paused");
	});

	test("runNumber increments across repeated resets", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const step = makePipelineStep({
			status: "completed",
			output: "run 1",
			startedAt: "2026-04-18T12:00:00.000Z",
			completedAt: "2026-04-18T12:01:00.000Z",
		});
		runner.resetStep(step, "pending");

		// Second run
		step.status = "error";
		step.output = "run 2";
		step.startedAt = "2026-04-18T12:02:00.000Z";
		step.completedAt = "2026-04-18T12:03:00.000Z";
		runner.resetStep(step, "pending");

		expect(step.history).toHaveLength(2);
		expect(step.history[0].runNumber).toBe(1);
		expect(step.history[1].runNumber).toBe(2);
		expect(step.history[1].status).toBe("error");
		expect(step.history[1].output).toBe("run 2");
	});

	test("archives errored runs across all repeatable step IDs", () => {
		const runner = new CLIStepRunner(makeMockCLIRunner() as CLIRunner);
		const repeatableStepNames = [
			"implement",
			"implement-review",
			"monitor-ci",
			"merge-pr",
			"feedback-implementer",
			"review",
		] as const;
		for (const name of repeatableStepNames) {
			const step = makePipelineStep({
				name,
				status: "error",
				output: `${name} output`,
				error: `${name} error`,
				startedAt: "2026-04-18T12:00:00.000Z",
				completedAt: "2026-04-18T12:01:00.000Z",
			});
			runner.resetStep(step, "pending");
			expect(step.history).toHaveLength(1);
			expect(step.history[0].status).toBe("error");
			expect(step.history[0].output).toBe(`${name} output`);
			expect(step.history[0].error).toBe(`${name} error`);
		}
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
			undefined,
			undefined,
		);
	});

	test("forwards model and effort to cliRunner.resume", () => {
		const cliRunner = makeMockCLIRunner();
		const runner = new CLIStepRunner(cliRunner as CLIRunner);
		const callbacks = {} as CLICallbacks;

		runner.resumeStep("wf-1", "sess-1", "/cwd", callbacks, undefined, undefined, "sonnet", "high");
		expect(cliRunner.resume).toHaveBeenCalledWith(
			"wf-1",
			"sess-1",
			"/cwd",
			callbacks,
			undefined,
			undefined,
			"sonnet",
			"high",
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
