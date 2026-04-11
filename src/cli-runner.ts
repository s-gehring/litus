import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configStore } from "./config-store";
import { toErrorMessage } from "./errors";
import { logger } from "./logger";
import { cleanEnv, readStream } from "./spawn-utils";
import { DELTA_FLUSH_TIMEOUT_MS, type EffortLevel, type ToolUsage, type Workflow } from "./types";

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
}

const EVENTS_DIR = join(homedir(), ".litus", "audit");
const EVENTS_FILE = join(EVENTS_DIR, "events.jsonl");

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
			"claude",
			"-p",
			workflow.specification,
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
			"--include-partial-messages",
		];
		if (model && model.trim() !== "") {
			args.push("--model", model);
		}
		if (effort) {
			args.push("--effort", effort);
		}

		const env = cleanEnv(extraEnv);

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			logger.info(`[cli-runner] Starting CLI for workflow ${workflow.id} | cwd=${cwd}`);
			proc = Bun.spawn(args, {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				env,
				windowsHide: true,
			});
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
			"claude",
			"-p",
			usedPrompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--dangerously-skip-permissions",
			"--resume",
			sessionId,
		];

		const env = cleanEnv(extraEnv);

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			logger.info(`[cli-runner] Resuming ${sessionId} for workflow ${workflowId}`);
			proc = Bun.spawn(args, {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				env,
				windowsHide: true,
			});
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
			entry.deltaBuffer = "";
		}
	}

	private handleStreamEvent(entry: RunningProcess, event: CLIStreamEvent): void {
		if (entry.stale) return;
		try {
			mkdirSync(EVENTS_DIR, { recursive: true });
			appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`);
		} catch {
			// Best-effort logging — don't break the pipeline
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
			for (const block of event.message.content) {
				if (block.type === "text" && block.text) {
					entry.callbacks.onOutput(block.text);
				} else if (block.type === "tool_use" && block.name) {
					toolUsages.push({ name: block.name, input: block.input });
				}
			}
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
