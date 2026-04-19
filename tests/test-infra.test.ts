import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CLICallbacks } from "../src/cli-runner";
import { DEFAULT_CONFIG } from "../src/config-store";
import { makeWorkflow } from "./helpers";
import {
	collectStream,
	createCallTracker,
	createDelayedStream,
	createMockCliRunner,
	createMockConfigStore,
	createMockEpicStore,
	createMockSpawn,
	createMockWebSocket,
	createMockWorkflowStore,
	createReadableStream,
	createTempRepo,
	expectStepStatus,
	expectValidWorkflow,
	expectWorkflowStatus,
	makeAppConfig,
	makeCompletedWorkflow,
	makeFailedWorkflow,
	makePersistedEpic,
	makePipelineStep,
	makeRunningWorkflow,
	makeWorkflowWithStatus,
	resetEpicCounter,
	withTempDir,
} from "./test-infra";

// ── CallTracker ──────────────────────────────────────────

describe("createCallTracker", () => {
	test("starts with empty calls", () => {
		const tracker = createCallTracker();
		expect(tracker.calls).toHaveLength(0);
		expect(tracker.callCount("any")).toBe(0);
	});

	test("records and queries calls", () => {
		const tracker = createCallTracker();
		tracker.calls.push({ method: "foo", args: [1, 2] });
		tracker.calls.push({ method: "bar", args: ["x"] });
		tracker.calls.push({ method: "foo", args: [3] });

		expect(tracker.callCount("foo")).toBe(2);
		expect(tracker.callCount("bar")).toBe(1);
		expect(tracker.callsTo("foo")).toHaveLength(2);
		expect(tracker.lastCallTo("foo")?.args).toEqual([3]);
		expect(tracker.lastCallTo("missing")).toBeUndefined();
	});

	test("reset clears all calls", () => {
		const tracker = createCallTracker();
		tracker.calls.push({ method: "foo", args: [] });
		tracker.reset();
		expect(tracker.calls).toHaveLength(0);
	});
});

// ── makeAppConfig ────────────────────────────────────────

describe("makeAppConfig", () => {
	test("zero-arg produces valid AppConfig with defaults", () => {
		const config = makeAppConfig();
		expect(config.models).toBeDefined();
		expect(config.efforts).toBeDefined();
		expect(config.prompts).toBeDefined();
		expect(config.limits).toBeDefined();
		expect(config.timing).toBeDefined();
		expect(typeof config.autoMode).toBe("string");
		expect(config.limits.reviewCycleMaxIterations).toBe(
			DEFAULT_CONFIG.limits.reviewCycleMaxIterations,
		);
	});

	test("overrides apply correctly", () => {
		const config = makeAppConfig({ autoMode: "full-auto" });
		expect(config.autoMode).toBe("full-auto");
	});

	test("does not mutate DEFAULT_CONFIG", () => {
		const config = makeAppConfig();
		config.autoMode = "full-auto";
		expect(DEFAULT_CONFIG.autoMode).toBe("normal");
	});
});

// ── makePersistedEpic ────────────────────────────────────

describe("makePersistedEpic", () => {
	test("zero-arg produces valid PersistedEpic", () => {
		const epic = makePersistedEpic();
		expect(epic.epicId).toBeTruthy();
		expect(epic.description).toBeTruthy();
		expect(epic.status).toBeDefined();
		expect(epic.startedAt).toBeTruthy();
		expect(epic.workflowIds).toBeInstanceOf(Array);
	});

	test("overrides apply correctly", () => {
		const epic = makePersistedEpic({
			status: "error",
			errorMessage: "timeout",
		});
		expect(epic.status).toBe("error");
		expect(epic.errorMessage).toBe("timeout");
	});

	test("resetEpicCounter produces deterministic IDs", () => {
		resetEpicCounter();
		const a = makePersistedEpic();
		const b = makePersistedEpic();
		expect(a.epicId).toBe("epic-1");
		expect(b.epicId).toBe("epic-2");

		resetEpicCounter();
		const c = makePersistedEpic();
		expect(c.epicId).toBe("epic-1");
	});
});

// ── makePipelineStep ─────────────────────────────────────

describe("makePipelineStep", () => {
	test("zero-arg produces valid PipelineStep", () => {
		const step = makePipelineStep();
		expect(step.name).toBeTruthy();
		expect(step.displayName).toBeTruthy();
		expect(step.status).toBe("pending");
		expect(step.error).toBeNull();
	});

	test("overrides apply correctly", () => {
		const step = makePipelineStep({
			name: "review",
			status: "running",
		});
		expect(step.name).toBe("review");
		expect(step.status).toBe("running");
	});
});

// ── makeWorkflowWithStatus ───────────────────────────────

describe("makeWorkflowWithStatus", () => {
	test("idle: all steps pending", () => {
		const wf = makeWorkflowWithStatus("idle");
		expect(wf.status).toBe("idle");
		for (const step of wf.steps) {
			expect(step.status).toBe("pending");
		}
	});

	test("running: steps before current completed, current running, rest pending", () => {
		const wf = makeWorkflowWithStatus("running", { stepName: "implement" });
		expect(wf.status).toBe("running");
		const implIdx = wf.steps.findIndex((s) => s.name === "implement");
		for (let i = 0; i < wf.steps.length; i++) {
			if (i < implIdx) expect(wf.steps[i].status).toBe("completed");
			else if (i === implIdx) expect(wf.steps[i].status).toBe("running");
			else expect(wf.steps[i].status).toBe("pending");
		}
	});

	test("completed: all steps completed with timestamps", () => {
		const wf = makeWorkflowWithStatus("completed");
		expect(wf.status).toBe("completed");
		for (const step of wf.steps) {
			expect(step.status).toBe("completed");
			expect(step.startedAt).toBeTruthy();
			expect(step.completedAt).toBeTruthy();
		}
	});

	test("error: error step has error field, prior steps completed", () => {
		const wf = makeWorkflowWithStatus("error", {
			stepName: "review",
			error: "lint failed",
		});
		expect(wf.status).toBe("error");
		const reviewIdx = wf.steps.findIndex((s) => s.name === "review");
		for (let i = 0; i < wf.steps.length; i++) {
			if (i < reviewIdx) expect(wf.steps[i].status).toBe("completed");
			else if (i === reviewIdx) {
				expect(wf.steps[i].status).toBe("error");
				expect(wf.steps[i].error).toBe("lint failed");
			} else expect(wf.steps[i].status).toBe("pending");
		}
	});

	test("paused: current step paused, prior completed", () => {
		const wf = makeWorkflowWithStatus("paused", { stepName: "plan" });
		expect(wf.status).toBe("paused");
		const planIdx = wf.steps.findIndex((s) => s.name === "plan");
		for (let i = 0; i < wf.steps.length; i++) {
			if (i < planIdx) expect(wf.steps[i].status).toBe("completed");
			else if (i === planIdx) expect(wf.steps[i].status).toBe("paused");
			else expect(wf.steps[i].status).toBe("pending");
		}
	});

	test("throws on invalid stepName", () => {
		expect(() => makeWorkflowWithStatus("running", { stepName: "nonexistent" })).toThrow(
			/Step 'nonexistent' not found/,
		);
	});
});

// ── Convenience workflow factories ───────────────────────

describe("convenience workflow factories", () => {
	test("makeCompletedWorkflow creates completed workflow", () => {
		const wf = makeCompletedWorkflow();
		expect(wf.status).toBe("completed");
		for (const step of wf.steps) {
			expect(step.status).toBe("completed");
		}
	});

	test("makeFailedWorkflow creates error workflow", () => {
		const wf = makeFailedWorkflow("implement", "build error");
		expect(wf.status).toBe("error");
		const step = wf.steps.find((s) => s.name === "implement");
		expect(step?.status).toBe("error");
		expect(step?.error).toBe("build error");
	});

	test("makeRunningWorkflow creates running workflow at step", () => {
		const wf = makeRunningWorkflow("implement");
		expect(wf.status).toBe("running");
		const step = wf.steps.find((s) => s.name === "implement");
		expect(step?.status).toBe("running");
	});
});

// ── createMockCliRunner ──────────────────────────────────

describe("createMockCliRunner", () => {
	function makeCallbacks(): CLICallbacks {
		return {
			onOutput: () => {},
			onTools: () => {},
			onComplete: () => {},
			onError: () => {},
			onSessionId: () => {},
		};
	}

	test("start/resume/kill are tracked", () => {
		const { mock, tracker } = createMockCliRunner();
		const cb = makeCallbacks();
		mock.start("wf-1", "/speckit-specify foo", cb);
		mock.resume("wf-1", "yes", cb);
		mock.kill("wf-1");
		mock.killAll();

		expect(tracker.callCount("start")).toBe(1);
		expect(tracker.callCount("resume")).toBe(1);
		expect(tracker.callCount("kill")).toBe(1);
		expect(tracker.callCount("killAll")).toBe(1);
		expect(tracker.lastCallTo("start")?.args[0]).toBe("wf-1");
	});

	test("emitOutput/emitComplete/emitError trigger callbacks", () => {
		const { mock, emitOutput, emitComplete, emitError, emitSessionId } = createMockCliRunner();
		const outputs: string[] = [];
		const errors: string[] = [];
		let completed = false;
		let sessionId = "";

		const cb: CLICallbacks = {
			onOutput: (text) => outputs.push(text),
			onTools: () => {},
			onComplete: () => {
				completed = true;
			},
			onError: (err) => errors.push(err),
			onSessionId: (id) => {
				sessionId = id;
			},
		};

		mock.start("wf-1", "test", cb);
		emitOutput("line 1");
		emitOutput("line 2");
		emitComplete();
		emitError("oops");
		emitSessionId("sess-123");

		expect(outputs).toEqual(["line 1", "line 2"]);
		expect(completed).toBe(true);
		expect(errors).toEqual(["oops"]);
		expect(sessionId).toBe("sess-123");
	});

	test("emitTools triggers onTools callback", () => {
		const { mock, emitTools } = createMockCliRunner();
		const receivedTools: Array<{ name: string }> = [];

		const cb: CLICallbacks = {
			onOutput: () => {},
			onTools: (tools) => receivedTools.push(...tools),
			onComplete: () => {},
			onError: () => {},
			onSessionId: () => {},
		};

		mock.start("wf-1", "test", cb);
		emitTools([{ name: "Read" }, { name: "Write", input: { path: "/tmp" } }]);

		expect(receivedTools).toHaveLength(2);
		expect(receivedTools[0].name).toBe("Read");
		expect(receivedTools[1].name).toBe("Write");
	});

	test("emitPid triggers onPid callback", () => {
		const { mock, emitPid } = createMockCliRunner();
		let receivedPid = 0;

		const cb: CLICallbacks = {
			onOutput: () => {},
			onTools: () => {},
			onComplete: () => {},
			onError: () => {},
			onSessionId: () => {},
			onPid: (pid) => {
				receivedPid = pid;
			},
		};

		mock.start("wf-1", "test", cb);
		emitPid(12345);

		expect(receivedPid).toBe(12345);
	});
});

// ── createMockWorkflowStore ──────────────────────────────

describe("createMockWorkflowStore", () => {
	test("save/load/loadAll tracked", async () => {
		const { mock, tracker } = createMockWorkflowStore();
		const wf = makeWorkflow({ id: "wf-1" });

		await mock.save(wf);
		const loaded = await mock.load("wf-1");
		const all = await mock.loadAll();

		expect(tracker.callCount("save")).toBe(1);
		expect(tracker.callCount("load")).toBe(1);
		expect(tracker.callCount("loadAll")).toBe(1);
		expect(loaded?.id).toBe("wf-1");
		expect(all).toHaveLength(1);
	});

	test("seedWorkflow pre-populates load()", async () => {
		const { mock, seedWorkflow } = createMockWorkflowStore();
		const wf = makeWorkflow({ id: "wf-seed" });
		seedWorkflow(wf);

		const loaded = await mock.load("wf-seed");
		expect(loaded?.id).toBe("wf-seed");
	});

	test("remove and removeAll work", async () => {
		const { mock, seedWorkflow } = createMockWorkflowStore();
		seedWorkflow(makeWorkflow({ id: "wf-1" }));
		seedWorkflow(makeWorkflow({ id: "wf-2" }));

		await mock.remove("wf-1");
		expect(await mock.load("wf-1")).toBeNull();
		expect(await mock.load("wf-2")).not.toBeNull();

		await mock.removeAll();
		expect(await mock.loadAll()).toHaveLength(0);
	});
});

// ── createMockEpicStore ──────────────────────────────────

describe("createMockEpicStore", () => {
	test("loadAll/save/removeAll tracked", async () => {
		const { mock, tracker } = createMockEpicStore();
		const epic = makePersistedEpic({ epicId: "e-1" });

		await mock.save(epic);
		const all = await mock.loadAll();
		await mock.removeAll();

		expect(tracker.callCount("save")).toBe(1);
		expect(tracker.callCount("loadAll")).toBe(1);
		expect(tracker.callCount("removeAll")).toBe(1);
		expect(all).toHaveLength(1);
		expect(all[0].epicId).toBe("e-1");
	});
});

// ── createMockConfigStore ────────────────────────────────

describe("createMockConfigStore", () => {
	test("get/save/reset tracked", () => {
		const { mock, tracker } = createMockConfigStore();

		const config = mock.get();
		expect(config.autoMode).toBe("normal");

		mock.save({ autoMode: "full-auto" });
		expect(mock.get().autoMode).toBe("full-auto");

		mock.reset();
		expect(mock.get().autoMode).toBe("normal");

		expect(tracker.callCount("get")).toBe(3);
		expect(tracker.callCount("save")).toBe(1);
		expect(tracker.callCount("reset")).toBe(1);
	});

	test("save deep-merges nested objects", () => {
		const { mock } = createMockConfigStore();

		mock.save({ limits: { reviewCycleMaxIterations: 99 } } as Partial<typeof DEFAULT_CONFIG>);

		const updated = mock.get();
		expect(updated.limits.reviewCycleMaxIterations).toBe(99);
		// Other limit fields should be preserved (not wiped by shallow merge)
		expect(Object.keys(updated.limits).length).toBeGreaterThan(1);
	});
});

// ── createMockWebSocket ──────────────────────────────────

describe("createMockWebSocket", () => {
	test("send/close/publish/subscribe tracked", () => {
		const { mock, tracker, sentMessages } = createMockWebSocket();

		mock.send('{"type":"test"}');
		mock.send('{"type":"test2"}');
		mock.close();
		mock.publish("topic-1", "msg");
		mock.subscribe("topic-1");

		expect(tracker.callCount("send")).toBe(2);
		expect(tracker.callCount("close")).toBe(1);
		expect(tracker.callCount("publish")).toBe(1);
		expect(tracker.callCount("subscribe")).toBe(1);
		expect(sentMessages).toEqual(['{"type":"test"}', '{"type":"test2"}']);
	});
});

// ── createMockSpawn ──────────────────────────────────────

describe("createMockSpawn", () => {
	test("configureExit/configureStdout/configureStderr work", async () => {
		const { mock, tracker, configureExit, configureStdout, configureStderr } = createMockSpawn();

		configureExit(1);
		configureStdout(["hello\n", "world\n"]);
		configureStderr(["err\n"]);

		const result = mock.spawn(["echo", "test"], {});
		const exitCode = await result.exited;
		const stdout = await collectStream(result.stdout as ReadableStream<Uint8Array>);
		const stderr = await collectStream(result.stderr as ReadableStream<Uint8Array>);

		expect(exitCode).toBe(1);
		expect(stdout).toBe("hello\nworld\n");
		expect(stderr).toBe("err\n");
		expect(tracker.callCount("spawn")).toBe(1);
		expect(tracker.lastCallTo("spawn")?.args[0]).toEqual(["echo", "test"]);
	});

	test("returns null streams when no lines configured", async () => {
		const { mock } = createMockSpawn();
		const result = mock.spawn(["test"], {});
		expect(result.stdout).toBeNull();
		expect(result.stderr).toBeNull();
	});
});

// ── withTempDir ──────────────────────────────────────────

describe("withTempDir", () => {
	test("directory exists during callback", async () => {
		let dirPath = "";
		await withTempDir((dir) => {
			dirPath = dir;
			expect(existsSync(dir)).toBe(true);
		});
		expect(dirPath).toBeTruthy();
	});

	test("cleaned up after normal completion", async () => {
		let dirPath = "";
		await withTempDir(async (dir) => {
			dirPath = dir;
			await Bun.write(join(dir, "test.txt"), "hello");
		});
		expect(existsSync(dirPath)).toBe(false);
	});

	test("cleaned up after callback throws, original error re-thrown", async () => {
		let dirPath = "";
		const err = new Error("test error");
		try {
			await withTempDir((dir) => {
				dirPath = dir;
				throw err;
			});
		} catch (e) {
			expect(e).toBe(err);
		}
		expect(existsSync(dirPath)).toBe(false);
	});

	test("throwOnCleanupFailure option is accepted and cleans up normally", async () => {
		let dirPath = "";
		await withTempDir(
			async (dir) => {
				dirPath = dir;
				await Bun.write(join(dir, "test.txt"), "hello");
			},
			{ throwOnCleanupFailure: true },
		);
		expect(existsSync(dirPath)).toBe(false);
	});
});

// ── createTempRepo ───────────────────────────────────────

describe("createTempRepo", () => {
	test("returned path is a valid git repo with at least one commit", async () => {
		const repoPath = await createTempRepo();
		try {
			expect(existsSync(repoPath)).toBe(true);
			expect(existsSync(join(repoPath, ".git"))).toBe(true);

			// Check for at least one commit
			const log = Bun.spawn(["git", "log", "--oneline"], {
				cwd: repoPath,
				stdout: "pipe",
				stderr: "pipe",
			});
			const output = await new Response(log.stdout).text();
			await log.exited;
			expect(output.trim()).toBeTruthy();
		} finally {
			rmSync(repoPath, { recursive: true, force: true });
		}
	});

	test("uses deterministic author info", async () => {
		const repoPath = await createTempRepo();
		try {
			const log = Bun.spawn(["git", "log", "--format=%an <%ae>"], {
				cwd: repoPath,
				stdout: "pipe",
				stderr: "pipe",
			});
			const output = await new Response(log.stdout).text();
			await log.exited;
			expect(output.trim()).toBe("Test Author <test@example.com>");
		} finally {
			rmSync(repoPath, { recursive: true, force: true });
		}
	});
});

// ── expectWorkflowStatus ─────────────────────────────────

describe("expectWorkflowStatus", () => {
	test("passes on match", () => {
		const wf = makeWorkflowWithStatus("completed");
		expect(() => expectWorkflowStatus(wf, "completed")).not.toThrow();
	});

	test("fails with descriptive message", () => {
		const wf = makeWorkflowWithStatus("error", {
			stepName: "implement",
			error: "timeout",
		});
		expect(() => expectWorkflowStatus(wf, "completed")).toThrow(
			/Expected workflow status 'completed' but got 'error'/,
		);
		expect(() => expectWorkflowStatus(wf, "completed")).toThrow(/implement/);
		expect(() => expectWorkflowStatus(wf, "completed")).toThrow(/timeout/);
	});
});

// ── expectValidWorkflow ──────────────────────────────────

describe("expectValidWorkflow", () => {
	test("passes for valid workflow", () => {
		const wf = makeWorkflow();
		expect(() => expectValidWorkflow(wf)).not.toThrow();
	});

	test("fails listing missing fields", () => {
		const wf = makeWorkflow();
		wf.id = "";
		expect(() => expectValidWorkflow(wf)).toThrow(/missing required field/);
		expect(() => expectValidWorkflow(wf)).toThrow(/id/);
	});
});

// ── expectStepStatus ─────────────────────────────────────

describe("expectStepStatus", () => {
	test("passes on match", () => {
		const wf = makeWorkflowWithStatus("running", { stepName: "implement" });
		expect(() => expectStepStatus(wf, "implement", "running")).not.toThrow();
	});

	test("fails with descriptive message", () => {
		const wf = makeWorkflowWithStatus("running", { stepName: "implement" });
		expect(() => expectStepStatus(wf, "implement", "completed")).toThrow(
			/Expected step 'implement' status 'completed' but got 'running'/,
		);
	});

	test("fails when step not found", () => {
		const wf = makeWorkflow();
		expect(() => expectStepStatus(wf, "nonexistent", "pending")).toThrow(/not found/);
	});
});

// ── createReadableStream + collectStream ─────────────────

describe("createReadableStream + collectStream", () => {
	test("round-trips string arrays", async () => {
		const stream = createReadableStream(["line 1\n", "line 2\n"]);
		const output = await collectStream(stream);
		expect(output).toBe("line 1\nline 2\n");
	});

	test("empty array produces empty string", async () => {
		const stream = createReadableStream([]);
		const output = await collectStream(stream);
		expect(output).toBe("");
	});
});

// ── createDelayedStream ──────────────────────────────────

describe("createDelayedStream", () => {
	test("produces correct output with observable delay", async () => {
		const start = Date.now();
		const stream = createDelayedStream(["a", "b", "c"], 10);
		const output = await collectStream(stream);
		const elapsed = Date.now() - start;

		expect(output).toBe("abc");
		// At least 2 delays of 10ms (between chunks 1-2 and 2-3), generous margin for CI
		expect(elapsed).toBeGreaterThanOrEqual(10);
	});
});
