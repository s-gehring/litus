import { describe, expect, test } from "bun:test";
import { FALLBACK_ICON, TOOL_ICONS } from "../../src/client/components/workflow-window";
import type { OutputEntry } from "../../src/types";

describe("Tool icon mapping", () => {
	const KNOWN_TOOLS = [
		"Agent",
		"Bash",
		"Edit",
		"Glob",
		"Grep",
		"Read",
		"Write",
		"TodoWrite",
		"ToolSearch",
		"write_file",
	];

	test("all 10 known tools have entries", () => {
		for (const tool of KNOWN_TOOLS) {
			expect(TOOL_ICONS[tool]).toBeDefined();
		}
		expect(Object.keys(TOOL_ICONS)).toHaveLength(10);
	});

	test("each tool has a unique icon", () => {
		const icons = Object.values(TOOL_ICONS).map((t) => t.icon);
		const unique = new Set(icons);
		expect(unique.size).toBe(icons.length);
	});

	test("each tool has a non-empty label", () => {
		for (const [name, mapping] of Object.entries(TOOL_ICONS)) {
			expect(mapping.label).toBeTruthy();
			expect(mapping.label).toBe(name);
		}
	});

	test("fallback icon exists with generic label", () => {
		expect(FALLBACK_ICON.icon).toBeTruthy();
		expect(FALLBACK_ICON.label).toBe("Tool");
	});

	test("unknown tool name falls back correctly", () => {
		const unknownTool = "SomeNewTool";
		const mapping = TOOL_ICONS[unknownTool] ?? FALLBACK_ICON;
		expect(mapping).toBe(FALLBACK_ICON);
	});
});

describe("OutputEntry accumulation", () => {
	test("mixed text and tools entries preserve order", () => {
		const entries: OutputEntry[] = [];

		entries.push({ kind: "text", text: "Hello world" });
		entries.push({ kind: "tools", tools: { Bash: 3, Read: 1 } });
		entries.push({ kind: "text", text: "More output" });
		entries.push({ kind: "tools", tools: { Write: 1 } });

		expect(entries).toHaveLength(4);
		expect(entries[0].kind).toBe("text");
		expect(entries[1].kind).toBe("tools");
		expect(entries[2].kind).toBe("text");
		expect(entries[3].kind).toBe("tools");

		if (entries[1].kind === "tools") {
			expect(entries[1].tools).toEqual({ Bash: 3, Read: 1 });
		}
	});

	test("text entries support type annotations", () => {
		const entries: OutputEntry[] = [
			{ kind: "text", text: "normal output" },
			{ kind: "text", text: "── Step: specify ──", type: "system" },
			{ kind: "text", text: "Something failed", type: "error" },
		];

		expect(entries[0].kind === "text" && entries[0].type).toBeUndefined();
		expect(entries[1].kind === "text" && entries[1].type).toBe("system");
		expect(entries[2].kind === "text" && entries[2].type).toBe("error");
	});

	test("tools entry with consecutive tools accumulates without text", () => {
		const entries: OutputEntry[] = [];

		entries.push({ kind: "tools", tools: { Bash: 1 } });
		entries.push({ kind: "tools", tools: { Read: 2, Grep: 1 } });

		expect(entries).toHaveLength(2);
		// Both are tools entries — client rendering handles attachment to last output line
	});
});
