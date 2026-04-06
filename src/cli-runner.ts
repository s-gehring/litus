import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EffortLevel, Workflow } from "./types";

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
	message?: { content?: Array<{ type: string; text?: string; name?: string }> };
	delta?: { text?: string };
	result?: unknown;
	[key: string]: unknown;
}

export interface CLICallbacks {
	onOutput: (text: string) => void;
	onTools: (tools: Record<string, number>) => void;
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
	deltaBuffer: string;
	deltaFlushTimer: ReturnType<typeof setTimeout> | null;
}

const EVENTS_DIR = join(homedir(), ".crab-studio", "audit");
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

		const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(args, {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				env,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[cli-runner] Failed to spawn process: ${msg}`);
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
			deltaBuffer: "",
			deltaFlushTimer: null,
		};

		this.running.set(workflow.id, entry);
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
		const defaultPrompt =
			"You were paused and are now being resumed. Before continuing, verify that any files you created or modified in this session actually exist on disk — if a file is missing or incomplete, recreate it. Then continue where you left off.";
		const args = [
			"claude",
			"-p",
			prompt ?? defaultPrompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--dangerously-skip-permissions",
			"--resume",
			sessionId,
		];

		const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(args, {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				env,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[cli-runner] Failed to spawn resume process: ${msg}`);
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
			deltaBuffer: "",
			deltaFlushTimer: null,
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
			entry.process.kill();
			this.running.delete(workflowId);
		}
	}

	killAll(): void {
		for (const entry of this.running.values()) {
			entry.process.kill();
		}
		this.running.clear();
	}

	private async streamOutput(entry: RunningProcess): Promise<void> {
		const { process: proc, callbacks, workflowId } = entry;
		const stdout = proc.stdout;
		if (!stdout || typeof stdout === "number") return;
		const reader = (stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

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
		} catch (_err) {
			// Stream read error
		}

		// Flush any remaining batched delta text
		this.flushDeltaBuffer(entry);

		const exitCode = await proc.exited;
		const currentEntry = this.running.get(workflowId);

		// Only handle completion if this is still the active process
		if (currentEntry && currentEntry.process === proc) {
			this.running.delete(workflowId);
			if (exitCode === 0) {
				callbacks.onComplete();
			} else {
				const stderrStream = proc.stderr;
				const stderr =
					stderrStream && typeof stderrStream !== "number"
						? await new Response(stderrStream as ReadableStream).text()
						: "";
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
			const toolCounts = new Map<string, number>();
			for (const block of event.message.content) {
				if (block.type === "text" && block.text) {
					entry.callbacks.onOutput(block.text);
				} else if (block.type === "tool_use" && block.name) {
					toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
				}
			}
			if (toolCounts.size > 0) {
				entry.callbacks.onTools(Object.fromEntries(toolCounts));
			}
		} else if (event.type === "content_block_delta" && event.delta?.text) {
			// Batch delta fragments to reduce DOM element count (CR3-010)
			entry.deltaBuffer += event.delta.text;
			if (entry.deltaFlushTimer) clearTimeout(entry.deltaFlushTimer);
			entry.deltaFlushTimer = setTimeout(() => this.flushDeltaBuffer(entry), 50);
		} else if (event.type === "result" && event.result !== undefined) {
			this.flushDeltaBuffer(entry);
			// Final result message
			if (event.session_id) {
				entry.sessionId = event.session_id;
			}
		}
	}
}
