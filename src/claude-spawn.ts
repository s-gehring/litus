import { tmpdir } from "node:os";
import { toErrorMessage } from "./errors";
import { logger } from "./logger";
import { cleanEnv, readStream, type SpawnLike } from "./spawn-utils";
import type { EffortLevel } from "./types";

/**
 * The SINGLE place in the codebase where the `claude` CLI is spawned.
 * Every invocation of Claude Code must go through `spawnClaude` — enforced
 * by `tests/claude-spawn-centralized.test.ts`.
 *
 * Prior to this, the same set of CLI flags was assembled inline in four
 * different files; a forgotten `--dangerously-skip-permissions` or a subtly
 * different `--output-format` in one of them was a recurring source of
 * "sometimes the invocation is broken" bugs.
 */

export interface SpawnClaudeOptions {
	cwd?: string;
	stdout?: "pipe" | "inherit" | "ignore";
	stderr?: "pipe" | "inherit" | "ignore";
	extraEnv?: Record<string, string>;
	/**
	 * Test hook: inject a mock spawn to avoid touching the real CLI.
	 * Production callers leave this unset.
	 */
	spawn?: SpawnLike["spawn"];
}

/**
 * Spawn the `claude` CLI with the given flag list.
 *
 * `args` is the argv passed to the binary, WITHOUT the leading `"claude"` —
 * that is prepended here so no caller can forget it.
 */
export function spawnClaude(
	args: string[],
	options: SpawnClaudeOptions = {},
): ReturnType<typeof Bun.spawn> {
	const fullArgs = ["claude", ...args];
	const spawnOpts = {
		cwd: options.cwd,
		stdout: options.stdout ?? "pipe",
		stderr: options.stderr ?? "pipe",
		env: cleanEnv(options.extraEnv),
		windowsHide: true,
	} as Parameters<typeof Bun.spawn>[1];

	if (options.spawn) {
		return options.spawn(fullArgs, spawnOpts as unknown as Record<string, unknown>) as ReturnType<
			typeof Bun.spawn
		>;
	}
	return Bun.spawn(fullArgs, spawnOpts);
}

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

export async function runClaude(options: RunClaudeOptions): Promise<RunClaudeResult> {
	const args: string[] = ["-p", options.prompt];

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
		const proc = spawnClaude(args, { cwd: options.cwd ?? tmpdir() });

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
			logger.warn(`[${label}] timed out after ${options.timeoutMs}ms`);
			return { ok: false, exitCode: -1, stdout: "", stderr: "timeout" };
		}

		const stdout = await readStream(proc.stdout);
		const stderr = await readStream(proc.stderr);

		if (exitCode !== 0 && options.callerLabel) {
			logger.warn(`[${options.callerLabel}] claude exited ${exitCode}: ${stderr.slice(0, 200)}`);
		}

		return { ok: exitCode === 0, exitCode, stdout, stderr };
	} catch (err) {
		const message = toErrorMessage(err);
		if (options.callerLabel) {
			logger.warn(`[${options.callerLabel}] spawn failed: ${message.slice(0, 200)}`);
		}
		return { ok: false, exitCode: -1, stdout: "", stderr: message };
	}
}
