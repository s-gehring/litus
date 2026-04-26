import { DELTA_FLUSH_TIMEOUT_MS, type ToolUsage } from "./types";

/**
 * Structural shape of a successfully JSON-parsed NDJSON line emitted by the
 * Claude Code CLI's `--output-format stream-json` mode. Loosely typed because
 * the CLI format is not formally documented; unknown event types pass through
 * untouched (see `[key: string]: unknown`).
 */
export interface ParsedStreamEvent {
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

/**
 * Callback bag handed to `parseClaudeStream`. Each callback may return
 * `void | Promise<void>` — the parser awaits each invocation before processing
 * the next line (FR-002 backpressure). A synchronous throw or rejected promise
 * from any callback is swallowed; the parser keeps draining (FR-011a).
 */
export interface ClaudeStreamCallbacks {
	onText: (text: string) => void | Promise<void>;
	onTools: (usages: ToolUsage[]) => void | Promise<void>;
	onSessionId: (sessionId: string) => void | Promise<void>;
	onJsonLine?: (line: string) => void | Promise<void>;
	onEvent?: (event: ParsedStreamEvent) => void | Promise<void>;
	onAssistantMessage?: (text: string) => void | Promise<void>;
}

export interface ParserResult {
	accumulatedText: string;
	sessionId: string | null;
}

/**
 * Single source of truth for parsing the Claude Code CLI's NDJSON stream.
 * Owns line splitting, JSON parsing, `assistant`-event text precedence over
 * `content_block_delta` fragments, `tool_use` extraction, single-fire
 * `session_id` capture, `result`-event flush-and-forward, and graceful
 * termination on stream end / read error / consumer-callback exception.
 *
 * The parser performs no I/O, no logging, and no global mutation. Diagnostic
 * logging stays the consumer's responsibility.
 */
export async function parseClaudeStream(
	stream: ReadableStream<Uint8Array>,
	callbacks: ClaudeStreamCallbacks,
): Promise<ParserResult> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let deltaBuffer = "";
	let deltaAccumulated = "";
	let lastAssistantText = "";
	let assistantSentLen = 0;
	let sessionId: string | null = null;
	let sessionIdReported = false;
	let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
	let resolved = false;

	async function safeInvoke<T>(
		fn: ((arg: T) => void | Promise<void>) | undefined,
		arg: T,
	): Promise<void> {
		if (!fn || resolved) return;
		try {
			await fn(arg);
		} catch {
			// FR-011a: callback exceptions are swallowed; parser keeps draining.
		}
	}

	async function flushDeltaBuffer(): Promise<void> {
		if (deltaFlushTimer) {
			clearTimeout(deltaFlushTimer);
			deltaFlushTimer = null;
		}
		if (deltaBuffer) {
			const text = deltaBuffer;
			deltaBuffer = "";
			await safeInvoke(callbacks.onText, text);
			// Track delta-flushed text so a subsequent `assistant` event with the
			// same cumulative content emits only the unsent tail (FR-005).
			assistantSentLen += text.length;
		}
	}

	function scheduleDeltaFlush(): void {
		if (deltaFlushTimer) clearTimeout(deltaFlushTimer);
		deltaFlushTimer = setTimeout(() => {
			void flushDeltaBuffer();
		}, DELTA_FLUSH_TIMEOUT_MS);
	}

	async function handleParseFailure(line: string): Promise<void> {
		if (callbacks.onJsonLine) {
			await safeInvoke(callbacks.onJsonLine, line);
		} else {
			await safeInvoke(callbacks.onText, line);
		}
	}

	async function handleLine(line: string): Promise<void> {
		let event: ParsedStreamEvent;
		try {
			event = JSON.parse(line) as ParsedStreamEvent;
		} catch {
			await handleParseFailure(line);
			return;
		}

		await safeInvoke(callbacks.onEvent, event);

		if (typeof event.session_id === "string" && event.session_id.length > 0 && !sessionIdReported) {
			sessionId = event.session_id;
			sessionIdReported = true;
			await safeInvoke(callbacks.onSessionId, event.session_id);
		}

		if (event.type === "assistant" && Array.isArray(event.message?.content)) {
			if (deltaFlushTimer) {
				clearTimeout(deltaFlushTimer);
				deltaFlushTimer = null;
			}
			deltaBuffer = "";

			let currentText = "";
			const toolUsages: ToolUsage[] = [];
			for (const block of event.message.content) {
				if (block.type === "text" && typeof block.text === "string" && block.text) {
					currentText += block.text;
				} else if (block.type === "tool_use" && typeof block.name === "string" && block.name) {
					toolUsages.push({ name: block.name, input: block.input });
				}
			}

			if (currentText.length < assistantSentLen) {
				assistantSentLen = 0;
			}
			const unsent = currentText.slice(assistantSentLen);
			if (unsent) {
				await safeInvoke(callbacks.onText, unsent);
			}
			lastAssistantText = currentText;

			if (toolUsages.length > 0) {
				await safeInvoke(callbacks.onTools, toolUsages);
			}

			if (callbacks.onAssistantMessage) {
				await safeInvoke(callbacks.onAssistantMessage, currentText);
			}
			// End-of-message reset (FR-006): the next assistant event begins a
			// fresh turn whose cumulative text is independent of this one.
			assistantSentLen = 0;
		} else if (
			event.type === "content_block_delta" &&
			typeof event.delta?.text === "string" &&
			event.delta.text.length > 0
		) {
			deltaAccumulated += event.delta.text;
			deltaBuffer += event.delta.text;
			scheduleDeltaFlush();
		} else if (event.type === "result") {
			await flushDeltaBuffer();
			if (typeof event.result === "string") {
				const trimmed = event.result.trim();
				if (trimmed) {
					await safeInvoke(callbacks.onText, trimmed);
				}
			}
		}
	}

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				await handleLine(line);
			}
		}
		if (buffer.trim()) {
			await handleLine(buffer);
			buffer = "";
		}
	} catch {
		// FR-011: read errors are tolerated; parser falls through to the
		// termination sequence and resolves with whatever it has accumulated.
	}

	if (deltaFlushTimer) {
		clearTimeout(deltaFlushTimer);
		deltaFlushTimer = null;
	}
	if (deltaBuffer) {
		const finalDelta = deltaBuffer;
		deltaBuffer = "";
		try {
			await callbacks.onText(finalDelta);
		} catch {
			// Same FR-011a tolerance as in-stream callbacks.
		}
	}

	resolved = true;
	return {
		accumulatedText: lastAssistantText !== "" ? lastAssistantText : deltaAccumulated,
		sessionId,
	};
}
