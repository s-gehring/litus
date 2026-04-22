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

		test("resume() includes --model and --effort when both are provided", async () => {
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

			runner.resume(
				"w-resume-model",
				"sess-xyz",
				WORKTREE_DIR,
				makeCallbacks({ onComplete: () => resolve() }),
				undefined,
				undefined,
				"claude-opus-4-7",
				"max",
			);

			await promise;
			expect(capturedArgs).toContain("--resume");
			expect(capturedArgs).toContain("sess-xyz");
			expect(capturedArgs).toContain("--model");
			expect(capturedArgs).toContain("claude-opus-4-7");
			expect(capturedArgs).toContain("--effort");
			expect(capturedArgs).toContain("max");
		});

		test("resume() omits --model when model is empty string", async () => {
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

			runner.resume(
				"w-resume-no-model",
				"sess-abc",
				WORKTREE_DIR,
				makeCallbacks({ onComplete: () => resolve() }),
				undefined,
				undefined,
				"",
				"low",
			);

			await promise;
			expect(capturedArgs).not.toContain("--model");
			expect(capturedArgs).toContain("--effort");
			expect(capturedArgs).toContain("low");
		});
	});

	describe("CLAUDE.md contract header injection (regression: slash-command steps)", () => {
		// The CLAUDE.md-is-Litus-managed contract header used to be prepended to
		// the user prompt by the orchestrator. That broke speckit steps whose
		// user prompts are bare slash commands (e.g. `/speckit-specify`), because
		// Claude Code's `-p` mode only intercepts slash commands when the prompt
		// starts with `/`. Pushing the slash command off the first character made
		// the CLI forward the raw text to the model — and the speckit skills set
		// `disable-model-invocation: true`, so the model replied with
		// "the `/speckit-specify` skill isn't registered".
		//
		// Fix: pass the header through `--append-system-prompt` so it stays in
		// system context while the user prompt remains pristine.
		function captureArgs(): { args: Promise<string[]> } {
			const { promise, resolve } = createDeferredPromise<string[]>();
			BunGlobal.Bun.spawn = (args: string[]) => {
				queueMicrotask(() => resolve(args));
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
			return { args: promise };
		}

		test("start() passes --append-system-prompt with the CLAUDE.md contract phrase", async () => {
			const { args } = captureArgs();
			runner.start(makeWorkflow("w-sys-start"), makeCallbacks());

			const captured = await args;
			const flagIdx = captured.indexOf("--append-system-prompt");
			expect(flagIdx).toBeGreaterThanOrEqual(0);
			expect(captured[flagIdx + 1]).toContain("CLAUDE.md is Litus-managed local context");
		});

		test("resume() passes --append-system-prompt with the CLAUDE.md contract phrase", async () => {
			const { args } = captureArgs();
			runner.resume("w-sys-resume", "sess-xyz", WORKTREE_DIR, makeCallbacks());

			const captured = await args;
			const flagIdx = captured.indexOf("--append-system-prompt");
			expect(flagIdx).toBeGreaterThanOrEqual(0);
			expect(captured[flagIdx + 1]).toContain("CLAUDE.md is Litus-managed local context");
		});

		test("bare slash-command step prompt reaches the CLI unwrapped (starts with /)", async () => {
			const { args } = captureArgs();
			runner.start(makeWorkflow("w-slash", { specification: "/speckit-specify" }), makeCallbacks());

			const captured = await args;
			// `-p` is followed by the user prompt; the first character must be `/`
			// so Claude Code intercepts the slash command.
			const pIdx = captured.indexOf("-p");
			expect(pIdx).toBeGreaterThanOrEqual(0);
			expect(captured[pIdx + 1]).toBe("/speckit-specify");
			expect(captured[pIdx + 1].startsWith("/")).toBe(true);
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

		test("does not duplicate text when both partial deltas and a final assistant message arrive", async () => {
			// Regression: the frontend was seeing LLM output twice because deltas
			// were flushed as they streamed in, and then the cumulative `assistant`
			// event re-emitted the same text in full.
			const outputs: string[] = [];
			const { promise: completePromise, resolve: resolveComplete } = createDeferredPromise();

			const streamContent = [
				JSON.stringify({ type: "content_block_delta", delta: { text: "Hello " } }),
				JSON.stringify({ type: "content_block_delta", delta: { text: "world" } }),
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: "Hello world" }] },
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
				makeWorkflow("w-dedup", { worktreePath: WORKTREE_DIR }),
				makeCallbacks({
					onOutput: (text) => outputs.push(text),
					onComplete: () => resolveComplete(),
				}),
			);

			await completePromise;
			const combined = outputs.join("");
			// The full message should appear exactly once across all outputs.
			expect(combined).toBe("Hello world");
		});

		test("emits full assistant text when no deltas were streamed", async () => {
			// The fix must not regress the non-partial path: if the CLI only
			// emits a final `assistant` event, that text still needs to reach
			// the frontend.
			const outputs: string[] = [];
			const { promise: completePromise, resolve: resolveComplete } = createDeferredPromise();

			const streamContent = [
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: "One-shot reply" }] },
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
				makeWorkflow("w-no-delta", { worktreePath: WORKTREE_DIR }),
				makeCallbacks({
					onOutput: (text) => outputs.push(text),
					onComplete: () => resolveComplete(),
				}),
			);

			await completePromise;
			expect(outputs.join("")).toBe("One-shot reply");
		});

		test("emits each assistant message separately across turns", async () => {
			// After an `assistant` event completes, the sent-length counter must
			// reset so a subsequent message (with its own deltas + finalization)
			// is still delivered to the frontend.
			const outputs: string[] = [];
			const { promise: completePromise, resolve: resolveComplete } = createDeferredPromise();

			const streamContent = [
				JSON.stringify({ type: "content_block_delta", delta: { text: "First " } }),
				JSON.stringify({ type: "content_block_delta", delta: { text: "reply" } }),
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: "First reply" }] },
				}),
				JSON.stringify({ type: "content_block_delta", delta: { text: "Second " } }),
				JSON.stringify({ type: "content_block_delta", delta: { text: "reply" } }),
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: "Second reply" }] },
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
				makeWorkflow("w-multi-turn", { worktreePath: WORKTREE_DIR }),
				makeCallbacks({
					onOutput: (text) => outputs.push(text),
					onComplete: () => resolveComplete(),
				}),
			);

			await completePromise;
			expect(outputs.join("")).toBe("First replySecond reply");
		});

		test("forwards the full finalized text to onAssistantMessage even when streamed as partials", async () => {
			// Question detection relies on finalized messages. When deltas
			// already emitted the text, the detector must still see the complete
			// text via onAssistantMessage — otherwise a clarify question that
			// streamed across partials would never be recognised.
			const assistantMessages: string[] = [];
			const { promise: completePromise, resolve: resolveComplete } = createDeferredPromise();

			const streamContent = [
				JSON.stringify({ type: "content_block_delta", delta: { text: "Which option " } }),
				JSON.stringify({ type: "content_block_delta", delta: { text: "do you prefer?" } }),
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: "Which option do you prefer?" }] },
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
				makeWorkflow("w-finalized", { worktreePath: WORKTREE_DIR }),
				makeCallbacks({
					onAssistantMessage: (text) => assistantMessages.push(text),
					onComplete: () => resolveComplete(),
				}),
			);

			await completePromise;
			expect(assistantMessages).toContain("Which option do you prefer?");
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
