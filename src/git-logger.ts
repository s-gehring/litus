import { logger } from "./logger";
import { readStream } from "./spawn-utils";

type GitLogCallback = (msg: string) => void;

interface GitSpawnResult {
	code: number;
	stdout: string;
	stderr: string;
}

let globalLogCallback: GitLogCallback | null = null;

/** Set a callback that receives all git log messages (for client-side output). */
export function setGitLogCallback(cb: GitLogCallback | null): void {
	globalLogCallback = cb;
}

function formatLog(
	cmd: string[],
	cwd: string | undefined,
	extra?: Record<string, string | undefined>,
): string {
	const parts = [`[git] ${cmd.join(" ")}`];
	if (cwd) parts.push(`cwd=${cwd}`);
	if (extra) {
		for (const [k, v] of Object.entries(extra)) {
			if (v !== undefined) parts.push(`${k}=${v}`);
		}
	}
	return parts.join(" | ");
}

function formatResult(cmd: string[], result: GitSpawnResult): string {
	const verb = cmd[0] === "gh" ? "gh" : "git";
	const sub = cmd.slice(1, cmd[0] === "gh" ? 3 : 2).join(" ");
	if (result.code === 0) {
		const out = result.stdout.trim();
		const summary = out ? ` → ${out.split("\n")[0].slice(0, 120)}` : "";
		return `[git] ${verb} ${sub}: ok (exit 0)${summary}`;
	}
	const err = result.stderr.trim() || result.stdout.trim();
	const summary = err ? ` → ${err.split("\n")[0].slice(0, 120)}` : "";
	return `[git] ${verb} ${sub}: failed (exit ${result.code})${summary}`;
}

/**
 * Spawn a git/gh command with automatic logging on both server (console)
 * and client (via the global log callback).
 */
export async function gitSpawn(
	cmd: string[],
	options?: { cwd?: string; extra?: Record<string, string | undefined> },
): Promise<GitSpawnResult> {
	const cwd = options?.cwd;
	const startMsg = formatLog(cmd, cwd, options?.extra);
	logger.info(startMsg);
	globalLogCallback?.(startMsg);

	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	const code = await proc.exited;
	const stdout = await readStream(proc.stdout as ReadableStream);
	const stderr = await readStream(proc.stderr as ReadableStream);

	const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
	const resultMsg = formatResult(cmd, result);
	logger.info(resultMsg);
	globalLogCallback?.(resultMsg);

	return result;
}
