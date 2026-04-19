import { existsSync, readFileSync } from "node:fs";

export interface CapturedClaudeCall {
	index: number;
	outputFormat: string;
	argv: string[];
}

/**
 * Read the scripted-claude invocation log written by `fakes/claude.ts`.
 * Each line is one call recorded in FIFO order. The file sits next to the
 * counter file under the sandbox (`<counterFile>.argv.jsonl`).
 *
 * Tests use this to assert on args passed to claude — for example, the
 * answer text carried in the `-p` prompt of a Full Auto resume call.
 */
export function readCapturedClaudeCalls(counterFile: string): CapturedClaudeCall[] {
	const path = `${counterFile}.argv.jsonl`;
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8");
	return raw
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as CapturedClaudeCall);
}

/**
 * Extract the `-p` prompt argument from a captured invocation, or null if
 * the call had no `-p` flag.
 */
export function promptOf(call: CapturedClaudeCall): string | null {
	const i = call.argv.indexOf("-p");
	if (i < 0 || i + 1 >= call.argv.length) return null;
	return call.argv[i + 1];
}
