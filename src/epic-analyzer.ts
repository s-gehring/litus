import { buildGraph, detectCycles } from "./dependency-resolver";
import type { EpicAnalysisResult } from "./types";

const DECOMPOSITION_PROMPT_TEMPLATE = `You are analyzing a codebase to decompose a large feature epic into multiple
self-contained implementation specifications.

## Epic Description

\${epicDescription}

## Instructions

1. Analyze the current codebase structure, patterns, and architecture.
2. Decompose the epic into the smallest set of self-contained specifications
   that together deliver the full scope of the epic.
3. Each spec MUST be independently implementable and testable.
4. Identify dependency relationships: if spec B requires changes from spec A
   to exist first, B depends on A.
5. Avoid circular dependencies.
6. If any part of the epic is infeasible given the current codebase, note it.

## Output Format

Return ONLY a JSON code block with this exact structure:

\`\`\`json
{
  "title": "Short epic title",
  "specs": [
    {
      "id": "a",
      "title": "Short spec title",
      "description": "Full specification description for this piece",
      "dependencies": []
    },
    {
      "id": "b",
      "title": "Another spec title",
      "description": "Full specification description",
      "dependencies": ["a"]
    }
  ],
  "infeasibleNotes": null
}
\`\`\`

Rules:
- \`id\` values are simple lowercase letters (a, b, c, ...)
- \`dependencies\` reference other spec \`id\` values within this decomposition
- \`description\` should be detailed enough to serve as a specification input
- If the epic is already atomic (cannot be split), return a single spec
- If parts are infeasible, set \`infeasibleNotes\` to explain why`;

export function buildDecompositionPrompt(epicDescription: string): string {
	return DECOMPOSITION_PROMPT_TEMPLATE.replace("${epicDescription}", epicDescription);
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
	if (!Array.isArray(obj.specs) || obj.specs.length === 0) {
		throw new Error("Invalid schema: missing or empty 'specs' array");
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

	const result = parsed as EpicAnalysisResult;

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

const DEFAULT_EPIC_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export async function analyzeEpic(
	epicDescription: string,
	targetRepoDir: string,
	onKillRef?: { current: EpicAnalysisProcess | null },
	timeoutMs: number = DEFAULT_EPIC_TIMEOUT_MS,
	callbacks?: EpicAnalysisCallbacks,
): Promise<EpicAnalysisResult> {
	const prompt = buildDecompositionPrompt(epicDescription);
	const args = [
		"claude",
		"-p",
		prompt,
		"--output-format",
		"stream-json",
		"--verbose",
		"--dangerously-skip-permissions",
		"--include-partial-messages",
	];

	const proc = Bun.spawn(args, {
		cwd: targetRepoDir,
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

	// Set up timeout
	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);

	const reader = (stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let accumulatedText = "";
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
					// Non-JSON line — emit as raw output
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

	if (timedOut) {
		throw new Error("Epic analysis timed out");
	}

	if (exitCode !== 0) {
		const stderrStream = proc.stderr;
		const stderr =
			stderrStream && typeof stderrStream !== "number"
				? await new Response(stderrStream as ReadableStream).text()
				: "";
		throw new Error(stderr.trim() || `CLI process exited with code ${exitCode}`);
	}

	return parseAnalysisResult(accumulatedText);
}
