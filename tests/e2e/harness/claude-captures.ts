import { existsSync, readFileSync } from "node:fs";

export interface CapturedClaudeCall {
	index: number;
	outputFormat: string;
	argv: string[];
	/**
	 * Prompt content fed to the CLI via stdin. Production code pipes user
	 * input here rather than embedding it in argv so very large prompts
	 * cannot blow the OS argv length cap. Empty string when nothing was
	 * piped (e.g. `--version`-style probes).
	 */
	stdin: string;
}

/**
 * Read the scripted-claude invocation log written by `fakes/claude.ts`.
 * Each line is one call recorded in FIFO order. The file sits next to the
 * counter file under the sandbox (`<counterFile>.argv.jsonl`).
 *
 * Tests use this to assert on args passed to claude — for example, the
 * answer text carried in the prompt of a Full Auto resume call.
 */
export function readCapturedClaudeCalls(counterFile: string): CapturedClaudeCall[] {
	const path = `${counterFile}.argv.jsonl`;
	if (!existsSync(path)) {
		// A missing argv log while the harness was wired up indicates the
		// fake `claude` never ran — tests that call this always expect at
		// least one invocation, so treating missing as empty would pass
		// assertions for the wrong reason.
		throw new Error(
			`no captured claude calls at ${path} — fake claude was never invoked. ` +
				"If this test genuinely expects zero invocations, assert on the " +
				"counter file directly instead of reading captures.",
		);
	}
	const raw = readFileSync(path, "utf8");
	return raw
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => {
			const parsed = JSON.parse(l) as Partial<CapturedClaudeCall> & {
				index: number;
				outputFormat: string;
				argv: string[];
			};
			// Older capture lines (pre stdin-pipe) lack `stdin`; default to "".
			return { ...parsed, stdin: parsed.stdin ?? "" } as CapturedClaudeCall;
		});
}

/**
 * Extract the prompt for a captured invocation. Production callers pipe the
 * prompt via stdin (the `stdin` field), so that's the primary source. Falls
 * back to a positional `-p <text>` arg for back-compat with any non-piped
 * caller, and returns null when neither is present.
 */
export function promptOf(call: CapturedClaudeCall): string | null {
	if (call.stdin && call.stdin.length > 0) return call.stdin;
	const i = call.argv.indexOf("-p");
	if (i < 0 || i + 1 >= call.argv.length) return null;
	const next = call.argv[i + 1];
	if (next.startsWith("-")) return null;
	return next;
}
