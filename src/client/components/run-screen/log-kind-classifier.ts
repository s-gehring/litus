// Hybrid classifier: honour server-tagged `kind` when present, otherwise apply
// a small heuristic rulebook. Falls back to `out` so every line gets a class
// (FR-032).

export type LogEventKind = "section" | "cmd" | "out" | "assistant" | "diff" | "toolstrip";

export interface LogToolItem {
	kind: "read" | "edit" | "grep" | "cmd";
	label?: string;
}

export interface DiffHunk {
	context: string;
	lines: Array<{ op: " " | "+" | "-"; text: string }>;
}

export type LogEvent =
	| { kind: "section"; text: string }
	| { kind: "cmd"; cwd: string | null; body: string }
	| { kind: "out"; text: string; muted?: boolean }
	| { kind: "assistant"; body: string }
	| { kind: "diff"; path: string; hunks: DiffHunk[] }
	| { kind: "toolstrip"; items: LogToolItem[] };

const SECTION_PATTERN = /^\s*(?:─{3,}|-{3,}|={3,}|#{1,3}\s)/;
const CMD_PREFIX_PATTERN = /^\s*\$\s+/;

/**
 * Classify a single output line into a typed LogEvent. `serverKind`, when
 * present, wins: the server has authoritative knowledge for `cmd`, `assistant`,
 * and `diff` classes. Unknown/untagged lines run through the heuristic and
 * always land on one of `section` / `out` (toolstrip events are synthesised
 * separately from `workflow:tools`, not from text lines).
 */
export function classifyLine(text: string, serverKind?: "cmd" | "assistant" | "diff"): LogEvent {
	if (serverKind === "cmd") return { kind: "cmd", cwd: null, body: text };
	if (serverKind === "assistant") return { kind: "assistant", body: text };
	if (serverKind === "diff") return { kind: "diff", path: text, hunks: [] };

	if (SECTION_PATTERN.test(text)) return { kind: "section", text };
	if (CMD_PREFIX_PATTERN.test(text)) {
		return { kind: "cmd", cwd: null, body: text.replace(CMD_PREFIX_PATTERN, "") };
	}
	return { kind: "out", text };
}
