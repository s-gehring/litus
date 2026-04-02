import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { CLICallbacks } from "../src/cli-runner";
import { CLIRunner } from "../src/cli-runner";
import type { Workflow } from "../src/types";

const originalSpawn = Bun.spawn;

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
		specification: "test",
		status: "running",
		sessionId: null,
		worktreePath: "/tmp/test-worktree",
		worktreeBranch: "test-branch",
		summary: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: [],
		currentStepIndex: 0,
		reviewCycle: { iteration: 1, maxIterations: 16, lastSeverity: null },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeCallbacks(overrides?: Partial<CLICallbacks>): CLICallbacks {
	return {
		onOutput: () => {},
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
				makeWorkflow("w2", { worktreePath: null }),
				makeCallbacks({
					onOutput: (text) => outputs.push(text),
					onComplete: () => resolveComplete(),
				}),
			);

			await completePromise;
			expect(outputs).toContain("I'll create the file now");
			expect(outputs).toContain("[Tool: write_file]");
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
				makeWorkflow("w3", { worktreePath: null }),
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
				makeWorkflow("w4", { worktreePath: null }),
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

			runner.start(makeWorkflow("w5", { worktreePath: null }), makeCallbacks());

			runner.kill("w5");
			expect(killed).toBe(true);
		});

		test("kill on non-existent workflow does not throw", () => {
			expect(() => runner.kill("nonexistent")).not.toThrow();
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

	describe("sendAnswer", () => {
		test("kills old process and spawns new one with --resume and correct cwd", async () => {
			let oldKilled = false;
			const spawnArgs: { args: string[]; opts: { cwd?: string } }[] = [];

			// First spawn: the initial start
			let spawnCount = 0;
			BunGlobal.Bun.spawn = (args: string[], opts: { cwd?: string }) => {
				spawnCount++;
				if (spawnCount === 1) {
					// Initial start — provide a session_id in the stream
					const streamContent = [
						JSON.stringify({ session_id: "sess-123", type: "system" }),
						"",
					].join("\n");
					return {
						stdout: new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(streamContent));
								// Don't close — keep the process "running"
							},
						}),
						stderr: new ReadableStream({ start() {} }),
						exited: new Promise(() => {}), // never resolves — process stays alive
						kill: () => {
							oldKilled = true;
						},
						pid: 1,
					};
				}
				// Second spawn: the resume after sendAnswer
				spawnArgs.push({ args, opts });
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
					pid: 2,
				};
			};

			const { promise: sessionPromise, resolve: resolveSession } = createDeferredPromise<string>();

			runner.start(
				makeWorkflow("w-answer", { worktreePath: "/tmp/my-worktree" }),
				makeCallbacks({ onSessionId: (id) => resolveSession(id) }),
			);

			// Wait for session ID to be extracted from the stream
			const sessionId = await sessionPromise;
			expect(sessionId).toBe("sess-123");

			// Now send an answer
			runner.sendAnswer("w-answer", "Use Tailwind CSS");

			expect(oldKilled).toBe(true);
			expect(spawnArgs.length).toBe(1);

			const resumeArgs = spawnArgs[0].args;
			expect(resumeArgs).toContain("--resume");
			expect(resumeArgs).toContain("sess-123");
			expect(resumeArgs).toContain("Use Tailwind CSS");

			const resumeOpts = spawnArgs[0].opts;
			expect(resumeOpts.cwd).toBe("/tmp/my-worktree");
		});

		test("calls onError when no session ID is available", () => {
			let errorMsg = "";
			BunGlobal.Bun.spawn = () => ({
				stdout: new ReadableStream({ start() {} }),
				stderr: new ReadableStream({ start() {} }),
				exited: new Promise(() => {}),
				kill: () => {},
				pid: 1,
			});

			runner.start(
				makeWorkflow("w-no-session"),
				makeCallbacks({
					onError: (err) => {
						errorMsg = err;
					},
				}),
			);

			// sendAnswer without having received a session ID
			runner.sendAnswer("w-no-session", "some answer");
			expect(errorMsg).toContain("session ID");
		});

		test("does nothing for non-existent workflow", () => {
			// Should not throw
			runner.sendAnswer("nonexistent", "answer");
		});
	});
});
