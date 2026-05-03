import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnClaude } from "./claude-spawn";
import { parseClaudeStream } from "./cli-stream-parser";
import { configStore } from "./config-store";
import type { EffortLevel } from "./config-types";
import { toErrorMessage } from "./errors";
import { auditDir } from "./litus-paths";
import { logger } from "./logger";
import { CLAUDE_MD_CONTRACT_HEADER } from "./prompt-header";
import { readStream, type SpawnLike } from "./spawn-utils";
import type { ToolUsage, Workflow } from "./types";

export interface OneShotStreamResult {
	exitCode: number;
	stderr: string;
}

export interface OneShotStreamCallbacks {
	onOutput: (msg: string) => void;
	onTools?: (tools: ToolUsage[]) => void;
}

/**
 * Run Claude with `--output-format stream-json` and forward human-readable
 * text (assistant text blocks and content_block_delta events) through
 * `onOutput` as it streams. Tool usages observed mid-stream are forwarded via
 * `onTools` when provided, mirroring the shape used by `CLIRunner.start` so
 * the UI can render them with the same affordances. Intended for fire-and-
 * forget invocations that are not bound to a workflow lifecycle (e.g. the
 * conflict-resolution dispatch in `pr-merger.ts`).
 *
 * The heavyweight `CLIRunner.start` path is tied to a `Workflow` — it tracks
 * sessions, audits events, and maintains an idle-timeout registry. This helper
 * shares the same stream-json parsing conventions but skips that bookkeeping.
 * Reading stdout/stderr to completion is mandatory: otherwise the OS pipe
 * buffer can fill and block a long-running Claude session.
 */
export async function streamClaudeOneShot(
	args: string[],
	cwd: string,
	callbacks: OneShotStreamCallbacks,
	spawn?: SpawnLike["spawn"],
	promptStdin?: string,
): Promise<OneShotStreamResult> {
	const proc = spawnClaude(args, { cwd, spawn, promptStdin });

	const stdout = proc.stdout;
	if (stdout && typeof stdout !== "number") {
		await parseClaudeStream(stdout as ReadableStream<Uint8Array>, {
			onText: callbacks.onOutput,
			onTools: callbacks.onTools ?? (() => {}),
			onSessionId: () => {},
		});
	}

	const exitCode = await proc.exited;
	const stderr = await readStream(proc.stderr);
	return { exitCode, stderr: stderr.trim() };
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function killProcess(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Process already dead
	}
}

export interface CLICallbacks {
	onOutput: (text: string) => void;
	onTools: (tools: ToolUsage[]) => void;
	onComplete: () => void;
	onError: (error: string) => void;
	onSessionId: (sessionId: string) => void;
	onPid?: (pid: number) => void;
	// Fires only on `assistant` events carrying the full message content —
	// partial `content_block_delta` fragments are intentionally excluded, so
	// the question detector sees a stable finalized view and cannot duplicate
	// a question that spans multiple deltas.
	onAssistantMessage?: (text: string) => void;
}

interface RunningProcess {
	process: ReturnType<typeof Bun.spawn>;
	workflowId: string;
	processKey: string;
	aspectId: string | null;
	sessionId: string | null;
	cwd: string;
	callbacks: CLICallbacks;
	stale: boolean;
	timedOut: boolean;
	idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Composite process key shape used when multiple processes run concurrently
 * for the same workflow (e.g. parallel research aspects). Not transmitted
 * over the wire — purely an in-memory `Map` key. Aspect ids are constrained
 * to `^[a-zA-Z0-9_-]+$` by `validateAspectManifest`, so the segments are
 * always safe identifiers.
 */
export function aspectProcessKey(workflowId: string, aspectId: string): string {
	return `${workflowId}::aspect::${aspectId}`;
}

export class CLIRunner {
	private running: Map<string, RunningProcess> = new Map();

	start(
		workflow: Workflow,
		callbacks: CLICallbacks,
		extraEnv?: Record<string, string>,
		model?: string,
		effort?: EffortLevel,
		opts?: { processKey?: string; aspectId?: string },
	): void {
		if (!workflow.worktreePath) {
			// Async error: start() is void-returning so callers can't catch a throw
			queueMicrotask(() =>
				callbacks.onError(
					`Workflow ${workflow.id} has no worktreePath — cannot determine working directory`,
				),
			);
			return;
		}

		const processKey = opts?.processKey ?? workflow.id;
		const aspectId = opts?.aspectId ?? null;

		// Guard: kill any lingering process under the same key before starting a new one.
		// For aspect-keyed processes this lets concurrent aspects coexist; for the
		// default workflow-keyed path it preserves the prior single-process invariant.
		const existing = this.running.get(processKey);
		if (existing) {
			logger.warn(
				`[cli-runner] Killing existing process (pid=${existing.process.pid}) for key ${processKey} before starting new one`,
			);
			existing.stale = true;
			if (existing.idleTimer) clearTimeout(existing.idleTimer);
			existing.process.kill();
			this.running.delete(processKey);
		}

		const cwd = workflow.worktreePath;
		const args = [
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
			"--include-partial-messages",
			"--append-system-prompt",
			CLAUDE_MD_CONTRACT_HEADER,
		];
		if (model && model.trim() !== "") {
			args.push("--model", model);
		}
		if (effort) {
			args.push("--effort", effort);
		}

		// Bun/libuv surface a missing cwd as `ENOENT: no such file or directory,
		// uv_spawn 'claude'` — the message names the binary, not the directory,
		// which sent at least one user down a rabbit hole chasing a PATH issue
		// that did not exist. Probe the cwd up front so the error names the
		// actual cause.
		if (!existsSync(cwd)) {
			const msg = `Worktree directory missing: ${cwd}`;
			logger.error(`[cli-runner] ${msg}`);
			queueMicrotask(() => callbacks.onError(msg));
			return;
		}

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			logger.info(`[cli-runner] Starting CLI for key ${processKey} | cwd=${cwd}`);
			proc = spawnClaude(args, { cwd, extraEnv, promptStdin: workflow.specification });
		} catch (err) {
			const msg = toErrorMessage(err);
			logger.error(`[cli-runner] Failed to spawn process: ${msg}`);
			queueMicrotask(() => callbacks.onError(msg));
			return;
		}

		const entry: RunningProcess = {
			process: proc,
			workflowId: workflow.id,
			processKey,
			aspectId,
			sessionId: null,
			cwd,
			callbacks,
			stale: false,
			timedOut: false,
			idleTimer: null,
		};

		this.running.set(processKey, entry);
		logger.info(`[cli-runner] Spawned pid=${proc.pid} for key ${processKey}`);
		callbacks.onPid?.(proc.pid);
		this.streamOutput(entry);
	}

	resume(
		workflowId: string,
		sessionId: string,
		cwd: string,
		callbacks: CLICallbacks,
		extraEnv?: Record<string, string>,
		prompt?: string,
		model?: string,
		effort?: EffortLevel,
		opts?: { processKey?: string; aspectId?: string },
	): void {
		const processKey = opts?.processKey ?? workflowId;
		const aspectId = opts?.aspectId ?? null;

		// Guard: kill any lingering process under the same key before resuming.
		const existing = this.running.get(processKey);
		if (existing) {
			logger.warn(
				`[cli-runner] Killing existing process (pid=${existing.process.pid}) for key ${processKey} before resuming`,
			);
			existing.stale = true;
			if (existing.idleTimer) clearTimeout(existing.idleTimer);
			existing.process.kill();
			this.running.delete(processKey);
		}

		const defaultPrompt =
			"You were paused and are now being resumed. Before continuing, verify that any files you created or modified in this session actually exist on disk — if a file is missing or incomplete, recreate it. Then continue where you left off.";
		const usedPrompt = prompt ?? defaultPrompt;
		const args = [
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--dangerously-skip-permissions",
			"--resume",
			sessionId,
			"--append-system-prompt",
			CLAUDE_MD_CONTRACT_HEADER,
		];
		if (model && model.trim() !== "") {
			args.push("--model", model);
		}
		if (effort) {
			args.push("--effort", effort);
		}

		if (!existsSync(cwd)) {
			const msg = `Worktree directory missing: ${cwd}`;
			logger.error(`[cli-runner] ${msg}`);
			queueMicrotask(() => callbacks.onError(msg));
			return;
		}

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			logger.info(`[cli-runner] Resuming ${sessionId} for workflow ${workflowId}`);
			proc = spawnClaude(args, { cwd, extraEnv, promptStdin: usedPrompt });
		} catch (err) {
			const msg = toErrorMessage(err);
			logger.error(`[cli-runner] Failed to spawn resume process: ${msg}`);
			queueMicrotask(() => callbacks.onError(msg));
			return;
		}

		const entry: RunningProcess = {
			process: proc,
			workflowId,
			processKey,
			aspectId,
			sessionId,
			cwd,
			callbacks,
			stale: false,
			timedOut: false,
			idleTimer: null,
		};

		this.running.set(processKey, entry);
		callbacks.onPid?.(proc.pid);
		this.streamOutput(entry);
	}

	kill(workflowIdOrKey: string): void {
		const entry = this.running.get(workflowIdOrKey);
		if (entry) {
			entry.stale = true;
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
			entry.process.kill();
			this.running.delete(workflowIdOrKey);
		}
	}

	/**
	 * Kill every running process owned by a given workflow id, including
	 * aspect-keyed processes. Used by the orchestrator on pause/abort/retry
	 * paths during a parallel research-aspect step.
	 */
	killAllForWorkflow(workflowId: string): void {
		for (const [key, entry] of this.running.entries()) {
			if (entry.workflowId !== workflowId) continue;
			entry.stale = true;
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
			entry.process.kill();
			this.running.delete(key);
		}
	}

	killAll(): void {
		for (const entry of this.running.values()) {
			entry.stale = true;
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
			entry.process.kill();
		}
		this.running.clear();
	}

	private resetIdleTimer(entry: RunningProcess): void {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		const timeoutMs = configStore.get().timing.cliIdleTimeoutMs;
		if (timeoutMs <= 0) return;
		entry.idleTimer = setTimeout(() => {
			if (entry.stale) return;
			logger.error(
				`[cli-runner] Idle timeout (${timeoutMs}ms) for key ${entry.processKey} — killing process`,
			);
			entry.stale = true;
			entry.timedOut = true;
			entry.process.kill();
		}, timeoutMs);
	}

	private async streamOutput(entry: RunningProcess): Promise<void> {
		const { process: proc, callbacks, workflowId, processKey, aspectId } = entry;
		const startTime = Date.now();
		const stdout = proc.stdout;
		if (!stdout || typeof stdout === "number") {
			logger.warn(`[cli-runner] No stdout pipe for key ${processKey} (stdout=${typeof stdout})`);
			return;
		}

		this.resetIdleTimer(entry);

		const eventsDir = auditDir();
		const eventsFile = join(eventsDir, "events.jsonl");
		try {
			mkdirSync(eventsDir, { recursive: true });
		} catch (err) {
			logger.warn("[cli-runner] Failed to ensure audit directory:", err);
		}

		try {
			await parseClaudeStream(stdout as ReadableStream<Uint8Array>, {
				onEvent: (event) => {
					this.resetIdleTimer(entry);
					if (entry.stale) return;
					try {
						// Wrap with workflow + aspect attribution only for aspect-keyed
						// processes; non-aspect rows keep their pre-spec wire shape so
						// existing audit consumers continue to parse them unchanged.
						const row = aspectId ? { workflowId, aspectId, event } : event;
						appendFileSync(eventsFile, `${JSON.stringify(row)}\n`);
					} catch (err) {
						logger.warn("[cli-runner] Failed to write audit event:", err);
					}
				},
				onText: (text) => {
					// Reset idle timer here too: the parser's onText fallback for
					// malformed-JSON lines bypasses onEvent, so without this a long
					// burst of malformed JSON would let the workflow time out even
					// though data is arriving.
					this.resetIdleTimer(entry);
					if (entry.stale) return;
					callbacks.onOutput(text);
				},
				onTools: (tools) => {
					if (entry.stale) return;
					callbacks.onTools(tools);
				},
				onSessionId: (id) => {
					if (entry.stale) return;
					// Only propagate on a fresh start (entry.sessionId starts null
					// from start(); resume() seeds it with the resumed id). On a
					// resumed stream, the first session_id event can carry a
					// transient/non-persisted id that Claude does NOT accept as
					// a future --resume target; overwriting step.sessionId with
					// it leaves the next answerQuestion → resume erroring with
					// "No conversation found with session ID". Keep the persisted
					// id stable across question/answer cycles.
					if (!entry.sessionId) {
						entry.sessionId = id;
						callbacks.onSessionId(id);
					}
				},
				onAssistantMessage: (text) => {
					if (entry.stale) return;
					callbacks.onAssistantMessage?.(text);
				},
			});
		} catch (err) {
			logger.error(`[cli-runner] Stream read error for workflow ${workflowId}: ${err}`);
		}

		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}

		const exitCode = await proc.exited;
		const elapsedMs = Date.now() - startTime;
		// Always read stderr for diagnostics
		const stderr = await readStream(proc.stderr);
		logger.info(
			`[cli-runner] pid=${proc.pid} key=${processKey} exited code=${exitCode} elapsed=${elapsedMs}ms session=${entry.sessionId ?? "none"}${stderr ? ` stderr=${stderr.slice(0, 300)}` : ""}`,
		);

		const currentEntry = this.running.get(processKey);

		// Only handle completion if this is still the active process
		if (currentEntry && currentEntry.process === proc) {
			const timedOut = entry.timedOut;
			this.running.delete(processKey);
			if (timedOut) {
				callbacks.onError("CLI process killed — no output received within idle timeout");
			} else if (exitCode === 0) {
				callbacks.onComplete();
			} else {
				callbacks.onError(stderr.trim() || `CLI process exited with code ${exitCode}`);
			}
		}
	}
}
