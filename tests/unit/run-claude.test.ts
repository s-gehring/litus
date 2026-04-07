import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runClaude } from "../../src/spawn-utils";

const originalSpawn = Bun.spawn;
const originalWarn = console.warn;

function mockSpawnResponse(stdout: string, stderr = "", exitCode = 0) {
	return {
		stdout: new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode(stdout));
				c.close();
			},
		}),
		stderr: new ReadableStream({
			start(c) {
				if (stderr) c.enqueue(new TextEncoder().encode(stderr));
				c.close();
			},
		}),
		exited: Promise.resolve(exitCode),
		pid: 1,
		kill: () => {},
	};
}

describe("runClaude", () => {
	let spawnMock: ReturnType<typeof mock>;

	beforeEach(() => {
		spawnMock = mock(() => mockSpawnResponse("output"));
		Bun.spawn = spawnMock as typeof Bun.spawn;
		console.warn = originalWarn;
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		console.warn = originalWarn;
	});

	describe("argument building", () => {
		test("prompt-only call builds correct args", async () => {
			await runClaude({ prompt: "hello" });
			const args = spawnMock.mock.calls[0][0] as string[];
			expect(args).toContain("claude");
			expect(args).toContain("-p");
			expect(args).toContain("hello");
			expect(args).toContain("--output-format");
			expect(args).toContain("text");
		});

		test("model flag omitted when undefined", async () => {
			await runClaude({ prompt: "hello" });
			const args = spawnMock.mock.calls[0][0] as string[];
			expect(args).not.toContain("--model");
		});

		test("model flag omitted when empty string", async () => {
			await runClaude({ prompt: "hello", model: "" });
			const args = spawnMock.mock.calls[0][0] as string[];
			expect(args).not.toContain("--model");
		});

		test("model flag omitted when whitespace-only", async () => {
			await runClaude({ prompt: "hello", model: "   " });
			const args = spawnMock.mock.calls[0][0] as string[];
			expect(args).not.toContain("--model");
		});

		test("model flag included when provided", async () => {
			await runClaude({ prompt: "hello", model: "claude-haiku-4-5-20251001" });
			const args = spawnMock.mock.calls[0][0] as string[];
			expect(args).toContain("--model");
			expect(args).toContain("claude-haiku-4-5-20251001");
		});

		test("effort flag included when provided", async () => {
			await runClaude({ prompt: "hello", effort: "low" });
			const args = spawnMock.mock.calls[0][0] as string[];
			expect(args).toContain("--effort");
			expect(args).toContain("low");
		});

		test("maxTurns flag included when provided", async () => {
			await runClaude({ prompt: "hello", maxTurns: 3 });
			const args = spawnMock.mock.calls[0][0] as string[];
			expect(args).toContain("--max-turns");
			expect(args).toContain("3");
		});

		test("verbose flag included when provided", async () => {
			await runClaude({ prompt: "hello", verbose: true });
			const args = spawnMock.mock.calls[0][0] as string[];
			expect(args).toContain("--verbose");
		});

		test("outputFormat defaults to text", async () => {
			await runClaude({ prompt: "hello" });
			const args = spawnMock.mock.calls[0][0] as string[];
			const fmtIdx = args.indexOf("--output-format");
			expect(args[fmtIdx + 1]).toBe("text");
		});

		test("outputFormat passes custom value", async () => {
			await runClaude({ prompt: "hello", outputFormat: "json" });
			const args = spawnMock.mock.calls[0][0] as string[];
			const fmtIdx = args.indexOf("--output-format");
			expect(args[fmtIdx + 1]).toBe("json");
		});

		test("cwd defaults to tmpdir()", async () => {
			const { tmpdir } = await import("node:os");
			await runClaude({ prompt: "hello" });
			const opts = spawnMock.mock.calls[0][1] as Record<string, unknown>;
			expect(opts.cwd).toBe(tmpdir());
		});

		test("cwd passes custom value", async () => {
			await runClaude({ prompt: "hello", cwd: "/custom/path" });
			const opts = spawnMock.mock.calls[0][1] as Record<string, unknown>;
			expect(opts.cwd).toBe("/custom/path");
		});
	});

	describe("result structure", () => {
		test("ok is true when exitCode is 0", async () => {
			spawnMock.mockImplementation(() => mockSpawnResponse("out", "", 0));
			const result = await runClaude({ prompt: "hello" });
			expect(result.ok).toBe(true);
			expect(result.exitCode).toBe(0);
		});

		test("ok is false when exitCode is non-zero", async () => {
			spawnMock.mockImplementation(() => mockSpawnResponse("", "err", 1));
			const result = await runClaude({ prompt: "hello" });
			expect(result.ok).toBe(false);
			expect(result.exitCode).toBe(1);
		});

		test("stdout and stderr captured correctly", async () => {
			spawnMock.mockImplementation(() => mockSpawnResponse("my output", "my error", 0));
			const result = await runClaude({ prompt: "hello" });
			expect(result.stdout).toBe("my output");
			expect(result.stderr).toBe("my error");
		});
	});

	describe("failure logging", () => {
		test("warning logged on non-zero exit code with callerLabel", async () => {
			const warnMock = mock(() => {});
			console.warn = warnMock as typeof console.warn;
			spawnMock.mockImplementation(() => mockSpawnResponse("", "something broke", 1));
			await runClaude({ prompt: "hello", callerLabel: "test-caller" });
			expect(warnMock).toHaveBeenCalledTimes(1);
			const msg = (warnMock.mock.calls as string[][])[0][0];
			expect(msg).toContain("test-caller");
			expect(msg).toContain("1");
		});

		test("stderr truncated to 200 chars in warning", async () => {
			const warnMock = mock(() => {});
			console.warn = warnMock as typeof console.warn;
			const longStderr = "x".repeat(300);
			spawnMock.mockImplementation(() => mockSpawnResponse("", longStderr, 1));
			await runClaude({ prompt: "hello", callerLabel: "truncate-test" });
			const msg = (warnMock.mock.calls as string[][])[0][0];
			expect(msg).toContain("x".repeat(200));
			expect(msg).not.toContain("x".repeat(201));
		});

		test("no warning logged on exit code 0", async () => {
			const warnMock = mock(() => {});
			console.warn = warnMock as typeof console.warn;
			spawnMock.mockImplementation(() => mockSpawnResponse("ok", "", 0));
			await runClaude({ prompt: "hello", callerLabel: "test-caller" });
			expect(warnMock).not.toHaveBeenCalled();
		});

		test("no warning logged when callerLabel is omitted", async () => {
			const warnMock = mock(() => {});
			console.warn = warnMock as typeof console.warn;
			spawnMock.mockImplementation(() => mockSpawnResponse("", "err", 1));
			await runClaude({ prompt: "hello" });
			expect(warnMock).not.toHaveBeenCalled();
		});
	});
});
