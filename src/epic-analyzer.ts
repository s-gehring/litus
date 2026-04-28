import { spawnClaude } from "./claude-spawn";
import { parseClaudeStream } from "./cli-stream-parser";
import { configStore } from "./config-store";
import { buildGraph, detectCycles } from "./dependency-resolver";
import { logger } from "./logger";
import { DELTA_FLUSH_TIMEOUT_MS } from "./protocol";
import type { EpicAnalysisResult, ToolUsage } from "./types";

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
	onTools?: (tools: ToolUsage[]) => void;
	/**
	 * Invoked the first time a CLI stream event carries a session id. Callers
	 * use this to persist `PersistedEpic.decompositionSessionId` mid-analysis
	 * so the id survives a crash/restart.
	 */
	onSessionId?: (sessionId: string) => void;
}

/**
 * Error thrown by `analyzeEpic` when a `--resume` invocation fails because the
 * prior session is unrecoverable (e.g. CLI reports "session not found"). The
 * caller is expected to fall back to a fresh non-resumed invocation with the
 * original prompt plus accumulated feedback text.
 */
export class UnrecoverableSessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnrecoverableSessionError";
	}
}

function isSessionNotFound(stderr: string): boolean {
	return /session.*not.*found|no.*such.*session|invalid.*session/i.test(stderr);
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
	const proc = spawnClaude(args, { cwd });

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

	const { accumulatedText, sessionId } = await parseClaudeStream(
		stdout as ReadableStream<Uint8Array>,
		{
			onText: (t) => callbacks?.onOutput?.(t),
			onTools: (t) => callbacks?.onTools?.(t),
			onSessionId: (id) => callbacks?.onSessionId?.(id),
		},
	);

	clearTimeout(timeoutId);
	const exitCode = await proc.exited;
	if (onKillRef) onKillRef.current = null;

	const stderr =
		proc.stderr && typeof proc.stderr !== "number"
			? (await new Response(proc.stderr as ReadableStream).text()).trim()
			: "";

	logger.info(`[epic] Stream done: accumulatedText=${accumulatedText.length} chars`);

	return { accumulatedText, sessionId, exitCode, timedOut, stderr };
}

const JSON_FIX_PROMPT =
	"Your previous response could not be parsed. Please respond with ONLY the valid JSON code block in the exact format requested. No other text.";

export async function analyzeEpic(
	epicDescription: string,
	targetRepoDir: string,
	onKillRef?: { current: EpicAnalysisProcess | null },
	timeoutMs?: number,
	callbacks?: EpicAnalysisCallbacks,
	resumeSessionId?: string | null,
): Promise<EpicAnalysisResult> {
	const prompt = buildDecompositionPrompt(epicDescription);
	const config = configStore.get();
	const model = config.models.epicDecomposition;
	const effort = config.efforts.epicDecomposition;
	const effectiveTimeout = timeoutMs ?? config.timing.epicTimeoutMs;
	const maxJsonRetries = config.limits.maxJsonRetries;
	const args = [
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
	if (resumeSessionId) {
		args.push("--resume", resumeSessionId);
	}
	if (model.trim() !== "") {
		args.push("--model", model);
	}

	const result = await runCLIStream(args, targetRepoDir, effectiveTimeout, onKillRef, callbacks);

	if (result.timedOut) throw new Error("Epic analysis timed out");
	if (result.exitCode !== 0) {
		if (resumeSessionId && isSessionNotFound(result.stderr)) {
			throw new UnrecoverableSessionError(
				result.stderr || "Prior decomposition session is unrecoverable",
			);
		}
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
			logger.error(
				`[epic] Parse attempt ${attempt + 1}/${maxJsonRetries + 1} failed: ${lastError.message}`,
			);
			logger.error(
				`[epic] Accumulated text (${accumulatedText.length} chars): ${accumulatedText.slice(0, 200)}...${accumulatedText.slice(-200)}`,
			);
			if (attempt >= maxJsonRetries || !sessionId) break;

			callbacks?.onOutput?.(`\n\n--- Retrying: ${lastError.message} ---\n\n`);

			const retryArgs = [
				"-p",
				JSON_FIX_PROMPT,
				"--resume",
				sessionId,
				"--output-format",
				"stream-json",
				"--verbose",
				"--dangerously-skip-permissions",
				"--include-partial-messages",
				"--effort",
				effort,
			];
			if (model.trim() !== "") {
				retryArgs.push("--model", model);
			}

			const retryResult = await runCLIStream(
				retryArgs,
				targetRepoDir,
				effectiveTimeout,
				onKillRef,
				callbacks,
			);

			if (retryResult.timedOut) throw new Error("Epic analysis timed out during retry");
			if (retryResult.exitCode !== 0) {
				// Sessions can expire between the initial stream finishing and
				// the retry firing (JSON parse latency, multi-retry budget).
				// Promote session-not-found into UnrecoverableSessionError so
				// the caller can trigger the fresh-fallback branch instead of
				// surfacing a raw stderr as a terminal failure.
				if (isSessionNotFound(retryResult.stderr)) {
					throw new UnrecoverableSessionError(
						retryResult.stderr || "Retry session is unrecoverable",
					);
				}
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
