// Project a stream of ToolUsage events into the right column's `TouchedFile[]`.
// Pure: no DOM, no time. Last-wins on duplicate paths.

import type { ToolUsage } from "../../../types";
import type { LogToolItem } from "./log-kind-classifier";
import type { TouchedFile } from "./run-screen-model";

const READ_TOOLS = new Set(["Read", "read"]);
const EDIT_TOOLS = new Set(["Edit", "Write"]);
const GREP_TOOLS = new Set(["Grep", "Glob"]);
const CMD_TOOLS = new Set(["Bash", "PowerShell"]);

function pathOf(tool: ToolUsage): string | null {
	const input = tool.input as Record<string, unknown> | undefined;
	if (!input) return null;
	for (const key of ["file_path", "path", "filePath"]) {
		const v = input[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return null;
}

export function projectTouchedFiles(tools: ToolUsage[]): TouchedFile[] {
	const byPath = new Map<string, TouchedFile>();
	for (const tool of tools) {
		const path = pathOf(tool);
		if (!path) continue;
		const isEdit = EDIT_TOOLS.has(tool.name);
		const isWrite = tool.name === "Write";
		const prev = byPath.get(path);
		const kind: TouchedFile["kind"] = isWrite && !prev ? "new" : isEdit ? "edit" : "read";
		byPath.set(path, {
			path,
			kind: prev?.kind === "new" ? "new" : kind,
			added: prev?.added ?? 0,
			removed: prev?.removed ?? 0,
		});
	}
	return Array.from(byPath.values());
}

/**
 * Map a batch of `workflow:tools` ToolUsage entries into a `toolstrip`
 * log-console row (one small icon per entry).
 */
export function toolUsagesToLogItems(tools: ToolUsage[]): LogToolItem[] {
	return tools.map((t): LogToolItem => {
		if (READ_TOOLS.has(t.name)) return { kind: "read", label: t.name };
		if (EDIT_TOOLS.has(t.name)) return { kind: "edit", label: t.name };
		if (GREP_TOOLS.has(t.name)) return { kind: "grep", label: t.name };
		if (CMD_TOOLS.has(t.name)) return { kind: "cmd", label: t.name };
		return { kind: "read", label: t.name };
	});
}
