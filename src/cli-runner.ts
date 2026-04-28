import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnClaude } from "./claude-spawn";
import { configStore } from "./config-store";
import type { EffortLevel } from "./config-types";
import { toErrorMessage } from "./errors";
import { auditDir } from "./litus-paths";
import { logger } from "./logger";
import { CLAUDE_MD_CONTRACT_HEADER } from "./prompt-header";
import { DELTA_FLUSH_TIMEOUT_MS } from "./protocol";
import { readStream, type SpawnLike } from "./spawn-utils";
import type { ToolUsage, Workflow } from "./types";

export interface OneShotStreamResult {
	exitCode: number;
	stderr: string;
}

/**
 * Run Claude with `--output-format stream-json` and forward human-readable
 * text (assistant text blocks and content_block_delta events) through
 * `onOutput` as it streams. Intended for fire-and-forget invocations that are
 * not bound to a workflow lifecycle (e.g. the conflict-resolution dispatch in
 * `pr-merger.ts`).
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
	onOutput: (msg: string) => void,
	spawn?: SpawnLike["spawn"],
): Promise<OneShotStreamResult> {
	const proc = spawnClaude(args, { cwd, spawn });

	const stdout = proc.stdout;
	if (stdout && typeof stdout !== "number") {
		const reader = (stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let deltaBuffer = "";
		let assistantSentLen = 0;
		const flushDelta = () => {
			if (deltaBuffer) {
				onOutput(deltaBuffer);
				deltaBuffer = "";
			}
		};
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line) as CLIStreamEvent;
						if (event.type === "assistant" && event.message?.content) {
							flushDelta();
							let currentText = "";
							for (const block of event.message.content) {
								if (block.type === "text" && block.text) currentText += block.text;
							}
							if (currentText.length < assistantSentLen) assistantSentLen = 0;
							const unsent = currentText.slice(assistantSentLen);
							if (unsent) {
								onOutput(unsent);
								assistantSentLen = currentText.length;
							}
						} else if (event.type === "content_block_delta" && event.delta?.text) {
							deltaBuffer += event.delta.text;
						} else if (event.type === "result" && typeof event.result === "string") {
							flushDelta();
							const trimmed = event.result.trim();
							if (trimmed) onOutput(trimmed);
						}
					} catch {
						// Non-JSON line — surface as raw output.
						onOutput(line);
					}
				}
			}
			if (buffer.trim()) {
				try {
					const event = JSON.parse(buffer) as CLIStreamEvent;
					if (event.type === "assistant" && event.message?.content) {
						for (const block of event.message.content) {
							if (block.type === "text" && block.text) onOutput(block.text);
						}
					}
				} catch {
					onOutput(buffer);
				}
			}
		} catch (err) {
			logger.warn(`[cli-runner] streamClaudeOneShot read error: ${toErrorMessage(err)}`);
		}
		flushDelta();
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

// Claude Code CLI stream-json event shape (loosely typed — the CLI format is not formally documented)
interface CLIStreamEvent {
	type: string;
	session_id?: string;
	message?: {
		content?: Array<{
			type: string;
			text?: string;
			name?: string;
			input?: Record<string, unknown>;
		}>;
	};
	delta?: { text?: string };
	result?: unknown;
	[key: string]: unknown;
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
	sessionId: string | null;
	cwd: string;
	callbacks: CLICallbacks;
	stale: boolean;
	timedOut: boolean;
	deltaBuffer: string;
	deltaFlushTimer: ReturnType<typeof setTimeout> | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
	// Tracks how many characters of the current assistant message text have
	// already been emitted via `onOutput` (either through flushed deltas or a
	// prior `assistant` event). When the CLI emits both `content_block_delta`
	// fragments AND a final cumulative `assistant` message, the frontend would
	// otherwise receive the text twice — once as streaming partials, then again
	// as the full finalized block. Only the unsent tail is forwarded.
	// Mirrors the deduplication pattern already in place for the one-shot
	// streaming helper (streamClaudeOneShot) and the question detector.
	assistantSentLen: number;
}

export class CLIRunner {
	private running: Map<string, RunningProcess> = new Map();

	start(
		workflow: Workflow,
		callbacks: CLICallbacks,
		extraEnv?: Record<string, string>,
		model?: string,
		effort?: EffortLevel,
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

		// Guard: kill any lingering process for this workflow before starting a new one
		const existing = this.running.get(workflow.id);
		if (existing) {
			logger.warn(
				`[cli-runner] Killing existing process (pid=${existing.process.pid}) for workflow ${workflow.id} before starting new one`,
			);
			existing.stale = true;
			if (existing.deltaFlushTimer) clearTimeout(existing.deltaFlushTimer);
			if (existing.idleTimer) clearTimeout(existing.idleTimer);
			existing.process.kill();
			this.running.delete(workflow.id);
		}

		const cwd = workflow.worktreePath;
		const args = [
			"-p",
			workflow.specification,
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
			logger.info(`[cli-runner] Starting CLI for workflow ${workflow.id} | cwd=${cwd}`);
			proc = spawnClaude(args, { cwd, extraEnv });
		} catch (err) {
			const msg = toErrorMessage(err);
			logger.error(`[cli-runner] Failed to spawn process: ${msg}`);
			queueMicrotask(() => callbacks.onError(msg));
			return;
		}

		const entry: RunningProcess = {
			process: proc,
			workflowId: workflow.id,
			sessionId: null,
			cwd,
			callbacks,
			stale: false,
			timedOut: false,
			deltaBuffer: "",
			deltaFlushTimer: null,
			idleTimer: null,
			assistantSentLen: 0,
		};

		this.running.set(workflow.id, entry);
		logger.info(`[cli-runner] Spawned pid=${proc.pid} for workflow ${workflow.id}`);
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
	): void {
		// Guard: kill any lingering process for this workflow
		const existing = this.running.get(workflowId);
		if (existing) {
			logger.warn(
				`[cli-runner] Killing existing process (pid=${existing.process.pid}) for workflow ${workflowId} before resuming`,
			);
			existing.stale = true;
			if (existing.deltaFlushTimer) clearTimeout(existing.deltaFlushTimer);
			if (existing.idleTimer) clearTimeout(existing.idleTimer);
			existing.process.kill();
			this.running.delete(workflowId);
		}

		const defaultPrompt =
			"You were paused and are now being resumed. Before continuing, verify that any files you created or modified in this session actually exist on disk — if a file is missing or incomplete, recreate it. Then continue where you left off.";
		const usedPrompt = prompt ?? defaultPrompt;
		const args = [
			"-p",
			usedPrompt,
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
			proc = spawnClaude(args, { cwd, extraEnv });
		} catch (err) {
			const msg = toErrorMessage(err);
			logger.error(`[cli-runner] Failed to spawn resume process: ${msg}`);
			queueMicrotask(() => callbacks.onError(msg));
			return;
		}

		const entry: RunningProcess = {
			process: proc,
			workflowId,
			sessionId,
			cwd,
			callbacks,
			stale: false,
			timedOut: false,
			deltaBuffer: "",
			deltaFlushTimer: null,
			idleTimer: null,
			assistantSentLen: 0,
		};

		this.running.set(workflowId, entry);
		callbacks.onPid?.(proc.pid);
		this.streamOutput(entry);
	}

	kill(workflowId: string): void {
		const entry = this.running.get(workflowId);
		if (entry) {
			entry.stale = true;
			if (entry.deltaFlushTimer) clearTimeout(entry.deltaFlushTimer);
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
			entry.process.kill();
			this.running.delete(workflowId);
		}
	}

	killAll(): void {
		for (const entry of this.running.values()) {
			entry.stale = true;
			if (entry.deltaFlushTimer) clearTimeout(entry.deltaFlushTimer);
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
				`[cli-runner] Idle timeout (${timeoutMs}ms) for workflow ${entry.workflowId} — killing process`,
			);
			entry.stale = true;
			entry.timedOut = true;
			entry.process.kill();
		}, timeoutMs);
	}

	private async streamOutput(entry: RunningProcess): Promise<void> {
		const { process: proc, callbacks, workflowId } = entry;
		const startTime = Date.now();
		const stdout = proc.stdout;
		if (!stdout || typeof stdout === "number") {
			logger.warn(
				`[cli-runner] No stdout pipe for workflow ${workflowId} (stdout=${typeof stdout})`,
			);
			return;
		}
		const reader = (stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let receivedAnyData = false;

		this.resetIdleTimer(entry);

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				if (!receivedAnyData) receivedAnyData = true;
				this.resetIdleTimer(entry);
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim() || entry.stale) continue;
					try {
						const event = JSON.parse(line);
						this.handleStreamEvent(entry, event);
					} catch {
						// Non-JSON line, treat as raw output
						if (!entry.stale) callbacks.onOutput(line);
					}
				}
			}

			// Process remaining buffer
			if (buffer.trim()) {
				try {
					const event = JSON.parse(buffer);
					this.handleStreamEvent(entry, event);
				} catch {
					callbacks.onOutput(buffer);
				}
			}
		} catch (err) {
			logger.error(`[cli-runner] Stream read error for workflow ${workflowId}: ${err}`);
		}

		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}

		// Flush any remaining batched delta text
		this.flushDeltaBuffer(entry);

		const exitCode = await proc.exited;
		const elapsedMs = Date.now() - startTime;
		// Always read stderr for diagnostics
		const stderr = await readStream(proc.stderr);
		logger.info(
			`[cli-runner] pid=${proc.pid} workflow=${workflowId} exited code=${exitCode} elapsed=${elapsedMs}ms receivedData=${receivedAnyData} session=${entry.sessionId ?? "none"}${stderr ? ` stderr=${stderr.slice(0, 300)}` : ""}`,
		);

		const currentEntry = this.running.get(workflowId);

		// Only handle completion if this is still the active process
		if (currentEntry && currentEntry.process === proc) {
			const timedOut = entry.timedOut;
			this.running.delete(workflowId);
			if (timedOut) {
				callbacks.onError("CLI process killed — no output received within idle timeout");
			} else if (exitCode === 0) {
				callbacks.onComplete();
			} else {
				callbacks.onError(stderr.trim() || `CLI process exited with code ${exitCode}`);
			}
		}
	}

	private flushDeltaBuffer(entry: RunningProcess): void {
		if (entry.deltaFlushTimer) {
			clearTimeout(entry.deltaFlushTimer);
			entry.deltaFlushTimer = null;
		}
		if (entry.deltaBuffer && !entry.stale) {
			entry.callbacks.onOutput(entry.deltaBuffer);
			entry.assistantSentLen += entry.deltaBuffer.length;
			entry.deltaBuffer = "";
		}
	}

	private handleStreamEvent(entry: RunningProcess, event: CLIStreamEvent): void {
		if (entry.stale) return;
		try {
			const eventsDir = auditDir();
			mkdirSync(eventsDir, { recursive: true });
			appendFileSync(join(eventsDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
		} catch (err) {
			logger.warn("[cli-runner] Failed to write audit event:", err);
		}
		// Extract session ID from the stream
		if (event.session_id && !entry.sessionId) {
			entry.sessionId = event.session_id;
			entry.callbacks.onSessionId(event.session_id);
		}

		// Handle different event types from stream-json format
		if (event.type === "assistant" && event.message?.content) {
			this.flushDeltaBuffer(entry);
			const toolUsages: ToolUsage[] = [];
			// Concatenate text blocks so we can compare against what has already
			// been streamed via `content_block_delta` fragments. Without this,
			// the frontend would see every character twice: once as partials,
			// then again as the final cumulative assistant message.
			let currentText = "";
			for (const block of event.message.content) {
				if (block.type === "text" && block.text) {
					currentText += block.text;
				} else if (block.type === "tool_use" && block.name) {
					toolUsages.push({ name: block.name, input: block.input });
				}
			}
			if (currentText) {
				// Only forward the tail that deltas have not already emitted.
				// If assistantSentLen exceeds currentText.length (fresh/shorter
				// message), slice() returns "" and we skip the emit, which is
				// safe — we'd rather drop a rare duplicate than print twice.
				const unsent = currentText.slice(entry.assistantSentLen);
				if (unsent) {
					entry.callbacks.onOutput(unsent);
				}
				// The finalized-message callback always fires with the full
				// text — question detection depends on seeing the whole
				// message regardless of what was already streamed as partials.
				entry.callbacks.onAssistantMessage?.(currentText);
			}
			// An `assistant` event marks end-of-message: reset the counter so
			// the next message's deltas / assistant events start fresh.
			entry.assistantSentLen = 0;
			if (toolUsages.length > 0) {
				entry.callbacks.onTools(toolUsages);
			}
		} else if (event.type === "content_block_delta" && event.delta?.text) {
			// Batch delta fragments to reduce DOM element count (CR3-010)
			entry.deltaBuffer += event.delta.text;
			if (entry.deltaFlushTimer) clearTimeout(entry.deltaFlushTimer);
			entry.deltaFlushTimer = setTimeout(
				() => this.flushDeltaBuffer(entry),
				DELTA_FLUSH_TIMEOUT_MS,
			);
		} else if (event.type === "result" && event.result !== undefined) {
			this.flushDeltaBuffer(entry);
			// Surface result text as output so errors like "Unknown skill" are visible
			if (typeof event.result === "string" && event.result.trim()) {
				entry.callbacks.onOutput(event.result);
			}
			if (event.session_id) {
				entry.sessionId = event.session_id;
			}
		}
	}
}
