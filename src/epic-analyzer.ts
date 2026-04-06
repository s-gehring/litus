import { configStore } from "./config-store";
import { buildGraph, detectCycles } from "./dependency-resolver";
import type { EpicAnalysisResult } from "./types";

export function buildDecompositionPrompt(epicDescription: string): string {
	const template = configStore.get().prompts.epicDecomposition;
	return template.replace("${epicDescription}", epicDescription);
}

export function parseAnalysisResult(text: string): EpicAnalysisResult {
	let json: string | null = null;

	// Try to extract JSON from code fence
	const fenceMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
	if (fenceMatch) {
		json = fenceMatch[1];
	} else {
		// Try parsing the entire text as JSON
		const trimmed = text.trim();
		if (trimmed.startsWith("{")) {
			json = trimmed;
		}
	}

	if (!json) {
		throw new Error("Could not parse decomposition result");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error("Could not parse decomposition result: invalid JSON");
	}

	// Validate schema
	const obj = parsed as Record<string, unknown>;
	if (!obj.title || typeof obj.title !== "string") {
		throw new Error("Invalid schema: missing or invalid 'title'");
	}
	if (!Array.isArray(obj.specs)) {
		throw new Error("Invalid schema: missing 'specs' array");
	}

	// Allow empty specs only if infeasibleNotes is present
	const hasInfeasibleNotes =
		typeof obj.infeasibleNotes === "string" && obj.infeasibleNotes.trim().length > 0;
	if (obj.specs.length === 0 && !hasInfeasibleNotes) {
		throw new Error("Invalid schema: empty 'specs' array without infeasibleNotes");
	}

	for (const spec of obj.specs) {
		const s = spec as Record<string, unknown>;
		if (!s.id || typeof s.id !== "string") {
			throw new Error("Invalid schema: spec missing 'id'");
		}
		if (!s.title || typeof s.title !== "string") {
			throw new Error("Invalid schema: spec missing 'title'");
		}
		if (!s.description || typeof s.description !== "string") {
			throw new Error("Invalid schema: spec missing 'description'");
		}
		if (!Array.isArray(s.dependencies)) {
			throw new Error("Invalid schema: spec missing 'dependencies' array");
		}
	}

	const result: EpicAnalysisResult = {
		title: obj.title as string,
		specs: (parsed as { specs: EpicAnalysisResult["specs"] }).specs,
		infeasibleNotes: hasInfeasibleNotes ? (obj.infeasibleNotes as string) : null,
		summary: typeof obj.summary === "string" ? obj.summary : null,
	};

	// Validate dependency references point to known spec IDs
	const specIds = new Set(result.specs.map((s) => s.id));
	for (const spec of result.specs) {
		for (const dep of spec.dependencies) {
			if (!specIds.has(dep)) {
				throw new Error(`Unknown dependency reference: "${dep}" in spec "${spec.id}"`);
			}
		}
	}

	// Validate no circular dependencies
	const graph = buildGraph(result.specs);
	const cycles = detectCycles(graph);
	if (cycles) {
		throw new Error(`Circular dependencies detected among specs: ${cycles.join(", ")}`);
	}

	return result;
}

export interface EpicAnalysisProcess {
	kill: () => void;
}

export interface EpicAnalysisCallbacks {
	onOutput?: (text: string) => void;
	onTools?: (tools: Record<string, number>) => void;
}

interface StreamResult {
	accumulatedText: string;
	sessionId: string | null;
	exitCode: number;
	timedOut: boolean;
	stderr: string;
}

async function runCLIStream(
	args: string[],
	cwd: string,
	timeoutMs: number,
	onKillRef?: { current: EpicAnalysisProcess | null },
	callbacks?: EpicAnalysisCallbacks,
): Promise<StreamResult> {
	const proc = Bun.spawn(args, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});

	if (onKillRef) {
		onKillRef.current = { kill: () => proc.kill() };
	}

	const stdout = proc.stdout;
	if (!stdout || typeof stdout === "number") {
		throw new Error("Failed to capture CLI stdout");
	}

	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);

	const reader = (stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let accumulatedText = "";
	let sessionId: string | null = null;
	let deltaBuffer = "";
	let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

	function flushDeltaBuffer() {
		if (deltaBuffer) {
			callbacks?.onOutput?.(deltaBuffer);
			deltaBuffer = "";
		}
		if (deltaFlushTimer) {
			clearTimeout(deltaFlushTimer);
			deltaFlushTimer = null;
		}
	}

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
					const event = JSON.parse(line);
					if (event.session_id && !sessionId) {
						sessionId = event.session_id;
					}
					if (event.type === "assistant" && event.message?.content) {
						flushDeltaBuffer();
						const toolCounts = new Map<string, number>();
						for (const block of event.message.content) {
							if (block.type === "text" && block.text) {
								accumulatedText += block.text;
								callbacks?.onOutput?.(block.text);
							} else if (block.type === "tool_use" && block.name) {
								toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
							}
						}
						if (toolCounts.size > 0) {
							callbacks?.onTools?.(Object.fromEntries(toolCounts));
						}
					} else if (event.type === "content_block_delta" && event.delta?.text) {
						accumulatedText += event.delta.text;
						deltaBuffer += event.delta.text;
						if (deltaFlushTimer) clearTimeout(deltaFlushTimer);
						deltaFlushTimer = setTimeout(flushDeltaBuffer, 50);
					}
				} catch {
					callbacks?.onOutput?.(line);
				}
			}
		}
	} catch {
		// Stream error
	}

	flushDeltaBuffer();
	clearTimeout(timeoutId);
	const exitCode = await proc.exited;
	if (onKillRef) onKillRef.current = null;

	const stderrStream = proc.stderr;
	const stderr =
		stderrStream && typeof stderrStream !== "number"
			? await new Response(stderrStream as ReadableStream).text()
			: "";

	return { accumulatedText, sessionId, exitCode, timedOut, stderr: stderr.trim() };
}

const JSON_FIX_PROMPT =
	"Your previous response could not be parsed. Please respond with ONLY the valid JSON code block in the exact format requested. No other text.";

export async function analyzeEpic(
	epicDescription: string,
	targetRepoDir: string,
	onKillRef?: { current: EpicAnalysisProcess | null },
	timeoutMs?: number,
	callbacks?: EpicAnalysisCallbacks,
): Promise<EpicAnalysisResult> {
	const prompt = buildDecompositionPrompt(epicDescription);
	const config = configStore.get();
	const model = config.models.epicDecomposition;
	const effort = config.efforts.epicDecomposition;
	const effectiveTimeout = timeoutMs ?? config.timing.epicTimeoutMs;
	const maxJsonRetries = config.limits.maxJsonRetries;
	const args = [
		"claude",
		"-p",
		prompt,
		"--output-format",
		"stream-json",
		"--verbose",
		"--dangerously-skip-permissions",
		"--include-partial-messages",
		"--effort",
		effort,
	];
	if (model.trim() !== "") {
		args.push("--model", model);
	}

	const result = await runCLIStream(args, targetRepoDir, effectiveTimeout, onKillRef, callbacks);

	if (result.timedOut) throw new Error("Epic analysis timed out");
	if (result.exitCode !== 0) {
		throw new Error(result.stderr || `CLI process exited with code ${result.exitCode}`);
	}

	// Try parsing, retry with --resume on JSON errors
	let lastError: Error | null = null;
	let sessionId = result.sessionId;
	let accumulatedText = result.accumulatedText;

	for (let attempt = 0; attempt <= maxJsonRetries; attempt++) {
		try {
			return parseAnalysisResult(accumulatedText);
		} catch (err) {
			lastError = err as Error;
			if (attempt >= maxJsonRetries || !sessionId) break;

			callbacks?.onOutput?.(`\n\n--- Retrying: ${lastError.message} ---\n\n`);

			const retryArgs = [
				"claude",
				"-p",
				JSON_FIX_PROMPT,
				"--resume",
				sessionId,
				"--output-format",
				"stream-json",
				"--verbose",
				"--dangerously-skip-permissions",
				"--include-partial-messages",
			];

			const retryResult = await runCLIStream(
				retryArgs,
				targetRepoDir,
				effectiveTimeout,
				onKillRef,
				callbacks,
			);

			if (retryResult.timedOut) throw new Error("Epic analysis timed out during retry");
			if (retryResult.exitCode !== 0) {
				throw new Error(
					retryResult.stderr || `CLI process exited with code ${retryResult.exitCode}`,
				);
			}

			if (retryResult.sessionId) sessionId = retryResult.sessionId;
			accumulatedText = retryResult.accumulatedText;
		}
	}

	throw lastError ?? new Error("Could not parse decomposition result");
}
