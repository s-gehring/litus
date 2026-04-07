import type { SpawnLike } from "../../src/spawn-utils";
import { type CallTracker, createCallTracker } from "./call-tracker";
import { createReadableStream } from "./streams";

export interface MockSpawn {
	mock: SpawnLike;
	tracker: CallTracker;
	configureExit(code: number): void;
	configureStdout(lines: string[]): void;
	configureStderr(lines: string[]): void;
}

/** Create a mock Bun.spawn with configurable exit code, stdout/stderr, and call tracking */
export function createMockSpawn(): MockSpawn {
	const tracker = createCallTracker();
	let exitCode = 0;
	let stdoutLines: string[] = [];
	let stderrLines: string[] = [];

	const mock: SpawnLike = {
		spawn(
			args: string[],
			opts?: Record<string, unknown>,
		): {
			exited: Promise<number>;
			stdout: ReadableStream | null;
			stderr: ReadableStream | null;
		} {
			tracker.calls.push({ method: "spawn", args: [args, opts] });
			return {
				exited: Promise.resolve(exitCode),
				stdout:
					stdoutLines.length > 0 ? createReadableStream(stdoutLines) : createReadableStream([]),
				stderr:
					stderrLines.length > 0 ? createReadableStream(stderrLines) : createReadableStream([]),
			};
		},
	};

	return {
		mock,
		tracker,
		configureExit(code: number): void {
			exitCode = code;
		},
		configureStdout(lines: string[]): void {
			stdoutLines = lines;
		},
		configureStderr(lines: string[]): void {
			stderrLines = lines;
		},
	};
}
