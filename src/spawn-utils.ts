import { tmpdir } from "node:os";
import type { EffortLevel } from "./types";

export interface RunClaudeOptions {
	prompt: string;
	model?: string;
	effort?: EffortLevel;
	outputFormat?: string;
	maxTurns?: number;
	cwd?: string;
	verbose?: boolean;
	callerLabel?: string;
	timeoutMs?: number;
}

export interface RunClaudeResult {
	ok: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Build an env object with CLAUDE* vars stripped to prevent child CLI from inheriting parent session state. */
export function cleanEnv(extra?: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !k.startsWith("CLAUDE")) {
			env[k] = v;
		}
	}
	if (extra) Object.assign(env, extra);
	return env;
}

export interface SpawnLike {
	spawn: (
		args: string[],
		opts?: Record<string, unknown>,
	) => {
		exited: Promise<number>;
		stdout: ReadableStream | null;
		stderr: ReadableStream | null;
	};
}

/**
 * Reads a stream to string. Accepts `number` because Bun.spawn may return
 * a file descriptor (number) when stdio is set to "inherit" or a fd index;
 * callers always pass `"pipe"` but the Bun type signature is a union.
 */
export async function readStream(
	stream: ReadableStream | number | null | undefined,
): Promise<string> {
	if (!stream || typeof stream === "number") return "";
	return new Response(stream as ReadableStream).text();
}

export async function runClaude(options: RunClaudeOptions): Promise<RunClaudeResult> {
	const args = ["claude", "-p", options.prompt];

	if (options.model?.trim()) {
		args.push("--model", options.model.trim());
	}
	if (options.effort) {
		args.push("--effort", options.effort);
	}
	args.push("--output-format", options.outputFormat ?? "text");
	if (options.maxTurns !== undefined) {
		args.push("--max-turns", String(options.maxTurns));
	}
	if (options.verbose) {
		args.push("--verbose");
	}

	try {
		const proc = Bun.spawn(args, {
			cwd: options.cwd ?? tmpdir(),
			stdout: "pipe",
			stderr: "pipe",
			env: cleanEnv(),
			windowsHide: true,
		});

		let timedOut = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		if (options.timeoutMs) {
			timeoutId = setTimeout(() => {
				timedOut = true;
				proc.kill();
			}, options.timeoutMs);
		}

		const exitCode = await proc.exited;
		if (timeoutId) clearTimeout(timeoutId);

		if (timedOut) {
			const label = options.callerLabel ?? "runClaude";
			console.warn(`[${label}] timed out after ${options.timeoutMs}ms`);
			return { ok: false, exitCode: -1, stdout: "", stderr: "timeout" };
		}

		const stdout = await readStream(proc.stdout);
		const stderr = await readStream(proc.stderr);

		if (exitCode !== 0 && options.callerLabel) {
			console.warn(`[${options.callerLabel}] claude exited ${exitCode}: ${stderr.slice(0, 200)}`);
		}

		return { ok: exitCode === 0, exitCode, stdout, stderr };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (options.callerLabel) {
			console.warn(`[${options.callerLabel}] spawn failed: ${message.slice(0, 200)}`);
		}
		return { ok: false, exitCode: -1, stdout: "", stderr: message };
	}
}
