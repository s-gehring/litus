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
const CWD_CMD_PATTERN = /^\s*\[([^\]]+)\]\s*\$\s+(.*)$/;

function parseDiffBody(text: string): { path: string; hunks: DiffHunk[] } | null {
	const lines = text.split(/\r?\n/);
	// Treat as structured diff only when the body contains at least one hunk
	// marker or an ◇ path header followed by content. A bare path string
	// ("path.ts") is not a diff body — keep hunks empty and let the caller
	// fall back to the legacy shape.
	const hasHunkMarker = lines.some((l) => l.startsWith("@@"));
	const diamondIdx = lines.findIndex((l) => /^◇\s+/.test(l));
	if (!hasHunkMarker && (diamondIdx === -1 || lines.length <= diamondIdx + 1)) return null;

	let path = "";
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | null = null;
	for (const raw of lines) {
		const diamond = raw.match(/^◇\s+(.*)$/);
		if (diamond) {
			path = diamond[1].trim();
			continue;
		}
		if (raw.startsWith("@@")) {
			current = { context: raw, lines: [] };
			hunks.push(current);
			continue;
		}
		if (!current) {
			if (raw.length === 0) continue;
			current = { context: "", lines: [] };
			hunks.push(current);
		}
		const op = raw.startsWith("+") ? "+" : raw.startsWith("-") ? "-" : " ";
		current.lines.push({ op, text: op === " " ? raw : raw.slice(1) });
	}
	return { path, hunks };
}

export function classifyLine(text: string, serverKind?: "cmd" | "assistant" | "diff"): LogEvent {
	if (serverKind === "cmd") {
		const m = text.match(CWD_CMD_PATTERN);
		if (m) return { kind: "cmd", cwd: m[1], body: m[2] };
		return { kind: "cmd", cwd: null, body: text };
	}
	if (serverKind === "assistant") return { kind: "assistant", body: text };
	if (serverKind === "diff") {
		const parsed = parseDiffBody(text);
		if (!parsed) return { kind: "diff", path: text, hunks: [] };
		return { kind: "diff", path: parsed.path || text, hunks: parsed.hunks };
	}

	if (SECTION_PATTERN.test(text)) return { kind: "section", text };
	const cwdCmd = text.match(CWD_CMD_PATTERN);
	if (cwdCmd) return { kind: "cmd", cwd: cwdCmd[1], body: cwdCmd[2] };
	if (CMD_PREFIX_PATTERN.test(text)) {
		return { kind: "cmd", cwd: null, body: text.replace(CMD_PREFIX_PATTERN, "") };
	}
	return { kind: "out", text };
}
