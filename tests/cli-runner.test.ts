import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CLICallbacks } from "../src/cli-runner";
import { CLIRunner } from "../src/cli-runner";
import type { ToolUsage, Workflow } from "../src/types";

const originalSpawn = Bun.spawn;

// Real directory used as the worktreePath in every workflow: the CLI runner now
// existsSync-checks the cwd before spawning, so a hard-coded phantom path would
// hit the missing-cwd guard instead of reaching the mocked Bun.spawn.
const WORKTREE_DIR = mkdtempSync(join(tmpdir(), "cli-runner-test-"));

// Typed helper for mocking Bun.spawn in tests
const BunGlobal = globalThis as unknown as { Bun: { spawn: unknown } };

function createDeferredPromise<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function makeWorkflow(id: string, overrides?: Partial<Workflow>): Workflow {
	return {
		id,
		workflowKind: "spec",
		specification: "test",
		status: "running",
		targetRepository: WORKTREE_DIR,
		worktreePath: WORKTREE_DIR,
		worktreeBranch: "test-branch",
		featureBranch: null,
		summary: "",
		stepSummary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: [],
		currentStepIndex: 0,
		reviewCycle: { iteration: 1, maxIterations: 16, lastSeverity: null },
		ciCycle: {
			attempt: 0,
			maxAttempts: 3,
			monitorStartedAt: null,
			globalTimeoutMs: 30 * 60 * 1000,
			lastCheckResults: [],
			failureLogs: [],
		},
		mergeCycle: {
			attempt: 0,
			maxAttempts: 3,
		},
		prUrl: null,
		epicId: null,
		epicTitle: null,
		epicDependencies: [],
		epicDependencyStatus: null,
		epicAnalysisMs: 0,
		activeWorkMs: 0,
		activeWorkStartedAt: null,
		feedbackEntries: [],
		feedbackPreRunHead: null,
		activeInvocation: null,
		managedRepo: null,
		error: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeCallbacks(overrides?: Partial<CLICallbacks>): CLICallbacks {
	return {
		onOutput: () => {},
		onTools: () => {},
		onComplete: () => {},
		onError: () => {},
		onSessionId: () => {},
		...overrides,
	};
}

describe("CLIRunner", () => {
	let runner: CLIRunner;

	beforeEach(() => {
		runner = new CLIRunner();
	});

	afterAll(() => {
		BunGlobal.Bun.spawn = originalSpawn;
		rmSync(WORKTREE_DIR, { recursive: true, force: true });
	});

	describe("model and effort flags", () => {
		test("includes --model and --effort when both are provided", async () => {
			let capturedArgs: string[] = [];
			const { promise, resolve } = createDeferredPromise();

			BunGlobal.Bun.spawn = (args: string[]) => {
				capturedArgs = args;
				return {
					stdout: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					stderr: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					exited: Promise.resolve(0),
					kill: () => {},
					pid: 1,
				};
			};

			runner.start(
				makeWorkflow("w-model"),
				makeCallbacks({ onComplete: () => resolve() }),
				undefined,
				"claude-sonnet-4-20250514",
				"high",
			);

			await promise;
			expect(capturedArgs).toContain("--model");
			expect(capturedArgs).toContain("claude-sonnet-4-20250514");
			expect(capturedArgs).toContain("--effort");
			expect(capturedArgs).toContain("high");
		});

		test("omits --model when model is empty string", async () => {
			let capturedArgs: string[] = [];
			const { promise, resolve } = createDeferredPromise();

			BunGlobal.Bun.spawn = (args: string[]) => {
				capturedArgs = args;
				return {
					stdout: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					stderr: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					exited: Promise.resolve(0),
					kill: () => {},
					pid: 1,
				};
			};

			runner.start(
				makeWorkflow("w-no-model"),
				makeCallbacks({ onComplete: () => resolve() }),
				undefined,
				"",
				"medium",
			);

			await promise;
			expect(capturedArgs).not.toContain("--model");
			expect(capturedArgs).toContain("--effort");
			expect(capturedArgs).toContain("medium");
		});

		test("omits --model and --effort when neither is provided", async () => {
			let capturedArgs: string[] = [];
			const { promise, resolve } = createDeferredPromise();

			BunGlobal.Bun.spawn = (args: string[]) => {
				capturedArgs = args;
				return {
					stdout: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					stderr: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					exited: Promise.resolve(0),
					kill: () => {},
					pid: 1,
				};
			};

			runner.start(makeWorkflow("w-defaults"), makeCallbacks({ onComplete: () => resolve() }));

			await promise;
			expect(capturedArgs).not.toContain("--model");
			expect(capturedArgs).not.toContain("--effort");
		});
	});

	describe("handleStreamEvent (via streamOutput)", () => {
		test("extracts session_id from stream events", async () => {
			const { promise: sessionPromise, resolve: resolveSession } = createDeferredPromise<string>();

			const streamContent = [
				JSON.stringify({ session_id: "sess-abc-123", type: "system", message: {} }),
				JSON.stringify({ type: "content_block_delta", delta: { text: "Hello" } }),
				"",
			].join("\n");

			BunGlobal.Bun.spawn = () => ({
				stdout: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(streamContent));
						controller.close();
					},
				}),
				stderr: new ReadableStream({
					start(c) {
						c.close();
					},
				}),
				exited: Promise.resolve(0),
				kill: () => {},
				pid: 1,
			});

			runner.start(makeWorkflow("w1"), makeCallbacks({ onSessionId: (id) => resolveSession(id) }));

			const sessionId = await sessionPromise;
			expect(sessionId).toBe("sess-abc-123");
		});

		test("emits text content from assistant messages", async () => {
			const outputs: string[] = [];
			const toolCalls: ToolUsage[][] = [];
			const { promise: completePromise, resolve: resolveComplete } = createDeferredPromise();

			const streamContent = [
				JSON.stringify({
					type: "assistant",
					message: {
						content: [
							{ type: "text", text: "I'll create the file now" },
							{ type: "tool_use", name: "write_file" },
						],
					},
				}),
				"",
			].join("\n");

			BunGlobal.Bun.spawn = () => ({
				stdout: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(streamContent));
						controller.close();
					},
				}),
				stderr: new ReadableStream({
					start(c) {
						c.close();
					},
				}),
				exited: Promise.resolve(0),
				kill: () => {},
				pid: 1,
			});

			runner.start(
				makeWorkflow("w2", { worktreePath: WORKTREE_DIR }),
				makeCallbacks({
					onOutput: (text) => outputs.push(text),
					onTools: (tools) => toolCalls.push(tools),
					onComplete: () => resolveComplete(),
				}),
			);

			await completePromise;
			expect(outputs).toContain("I'll create the file now");
			expect(toolCalls).toHaveLength(1);
			expect(toolCalls[0]).toEqual([{ name: "write_file", input: undefined }]);
		});

		test("passes individual tool usages with input", async () => {
			const toolCalls: ToolUsage[][] = [];
			const { promise: completePromise, resolve: resolveComplete } = createDeferredPromise();

			const streamContent = [
				JSON.stringify({
					type: "assistant",
					message: {
						content: [
							{ type: "tool_use", name: "Bash", input: { command: "ls" } },
							{ type: "tool_use", name: "Read", input: { file_path: "/tmp/foo.ts" } },
							{ type: "tool_use", name: "Write" },
						],
					},
				}),
				"",
			].join("\n");

			BunGlobal.Bun.spawn = () => ({
				stdout: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(streamContent));
						controller.close();
					},
				}),
				stderr: new ReadableStream({
					start(c) {
						c.close();
					},
				}),
				exited: Promise.resolve(0),
				kill: () => {},
				pid: 1,
			});

			runner.start(
				makeWorkflow("w-tools", { worktreePath: WORKTREE_DIR }),
				makeCallbacks({
					onTools: (tools) => toolCalls.push(tools),
					onComplete: () => resolveComplete(),
				}),
			);

			await completePromise;
			expect(toolCalls).toHaveLength(1);
			expect(toolCalls[0]).toEqual([
				{ name: "Bash", input: { command: "ls" } },
				{ name: "Read", input: { file_path: "/tmp/foo.ts" } },
				{ name: "Write", input: undefined },
			]);
		});

		test("calls onComplete on successful exit", async () => {
			const { promise: completePromise, resolve: resolveComplete } = createDeferredPromise();

			BunGlobal.Bun.spawn = () => ({
				stdout: new ReadableStream({
					start(c) {
						c.close();
					},
				}),
				stderr: new ReadableStream({
					start(c) {
						c.close();
					},
				}),
				exited: Promise.resolve(0),
				kill: () => {},
				pid: 1,
			});

			runner.start(
				makeWorkflow("w3", { worktreePath: WORKTREE_DIR }),
				makeCallbacks({ onComplete: () => resolveComplete() }),
			);

			await completePromise;
			// If we reach here, onComplete was called
		});

		test("calls onError on non-zero exit", async () => {
			const { promise: errorPromise, resolve: resolveError } = createDeferredPromise<string>();

			BunGlobal.Bun.spawn = () => ({
				stdout: new ReadableStream({
					start(c) {
						c.close();
					},
				}),
				stderr: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("process crashed"));
						controller.close();
					},
				}),
				exited: Promise.resolve(1),
				kill: () => {},
				pid: 1,
			});

			runner.start(
				makeWorkflow("w4", { worktreePath: WORKTREE_DIR }),
				makeCallbacks({ onError: (err) => resolveError(err) }),
			);

			const errorMsg = await errorPromise;
			expect(errorMsg).toContain("process crashed");
		});
	});

	describe("kill", () => {
		test("kills a running process", () => {
			let killed = false;
			BunGlobal.Bun.spawn = () => ({
				stdout: new ReadableStream({ start() {} }), // never closes
				stderr: new ReadableStream({ start() {} }),
				exited: new Promise(() => {}), // never resolves
				kill: () => {
					killed = true;
				},
				pid: 1,
			});

			runner.start(makeWorkflow("w5", { worktreePath: WORKTREE_DIR }), makeCallbacks());

			runner.kill("w5");
			expect(killed).toBe(true);
		});

		test("kill on non-existent workflow does not throw", () => {
			expect(() => runner.kill("nonexistent")).not.toThrow();
		});
	});

	describe("missing worktree directory", () => {
		test("start() surfaces a clear error and does not spawn when the cwd does not exist", async () => {
			let spawnCalled = false;
			BunGlobal.Bun.spawn = () => {
				spawnCalled = true;
				return {
					stdout: new ReadableStream({ start() {} }),
					stderr: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					exited: Promise.resolve(0),
					kill: () => {},
					pid: 1,
				};
			};

			let errorMsg = "";
			runner.start(
				makeWorkflow("w-missing-cwd", { worktreePath: "/definitely/does/not/exist/xyz" }),
				makeCallbacks({
					onError: (err) => {
						errorMsg = err;
					},
				}),
			);

			await new Promise((r) => setTimeout(r, 10));
			expect(spawnCalled).toBe(false);
			expect(errorMsg).toContain("Worktree directory missing");
			expect(errorMsg).toContain("/definitely/does/not/exist/xyz");
		});

		test("resume() surfaces a clear error and does not spawn when the cwd does not exist", async () => {
			let spawnCalled = false;
			BunGlobal.Bun.spawn = () => {
				spawnCalled = true;
				return {
					stdout: new ReadableStream({ start() {} }),
					stderr: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					exited: Promise.resolve(0),
					kill: () => {},
					pid: 1,
				};
			};

			let errorMsg = "";
			runner.resume(
				"w-missing-cwd-resume",
				"sess-xyz",
				"/definitely/does/not/exist/xyz",
				makeCallbacks({
					onError: (err) => {
						errorMsg = err;
					},
				}),
			);

			await new Promise((r) => setTimeout(r, 10));
			expect(spawnCalled).toBe(false);
			expect(errorMsg).toContain("Worktree directory missing");
		});
	});

	describe("null worktreePath", () => {
		test("calls onError and does not spawn when worktreePath is null", async () => {
			let spawnCalled = false;
			BunGlobal.Bun.spawn = () => {
				spawnCalled = true;
				return {
					stdout: new ReadableStream({ start() {} }),
					stderr: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					exited: Promise.resolve(0),
					kill: () => {},
					pid: 1,
				};
			};

			let errorMsg = "";
			runner.start(
				makeWorkflow("w-null", { worktreePath: null }),
				makeCallbacks({
					onError: (err) => {
						errorMsg = err;
					},
				}),
			);

			// Error is delivered via queueMicrotask
			await new Promise((r) => setTimeout(r, 10));
			expect(spawnCalled).toBe(false);
			expect(errorMsg).toContain("has no worktreePath");
		});
	});

	describe("killAll", () => {
		test("kills all running processes", () => {
			const killed: string[] = [];
			BunGlobal.Bun.spawn = () => ({
				stdout: new ReadableStream({ start() {} }),
				stderr: new ReadableStream({ start() {} }),
				exited: new Promise(() => {}),
				kill: () => {
					killed.push("killed");
				},
				pid: 1,
			});

			runner.start(makeWorkflow("a"), makeCallbacks());
			runner.start(makeWorkflow("b"), makeCallbacks());

			runner.killAll();
			expect(killed.length).toBe(2);
		});
	});
});
