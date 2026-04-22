import { describe, expect, it } from "bun:test";
import {
	EDIT_TOOLS,
	projectTouchedFiles,
	READ_TOOLS,
	toolUsagesToLogItems,
} from "../../../src/client/components/run-screen/touched-files-projector";
import type { ToolUsage } from "../../../src/types";

function tool(name: string, path: string | null): ToolUsage {
	return { name, input: path ? { file_path: path } : {} };
}

describe("touched-files-projector", () => {
	it("classifies Read as read, Edit as edit, Write as new", () => {
		const files = projectTouchedFiles([
			tool("Read", "a.ts"),
			tool("Edit", "b.ts"),
			tool("Write", "c.ts"),
		]);
		const byPath = new Map(files.map((f) => [f.path, f]));
		expect(byPath.get("a.ts")?.kind).toBe("read");
		expect(byPath.get("b.ts")?.kind).toBe("edit");
		expect(byPath.get("c.ts")?.kind).toBe("new");
	});

	it("skips tool invocations with no extractable path", () => {
		const files = projectTouchedFiles([
			tool("Grep", null),
			tool("Bash", null),
			tool("Read", "x.ts"),
		]);
		expect(files.map((f) => f.path)).toEqual(["x.ts"]);
	});

	it("aggregation preserves first-seen order", () => {
		const files = projectTouchedFiles([
			tool("Read", "first.ts"),
			tool("Edit", "second.ts"),
			tool("Write", "third.ts"),
		]);
		expect(files.map((f) => f.path)).toEqual(["first.ts", "second.ts", "third.ts"]);
	});

	it("Edit after Read on same path upgrades kind to edit", () => {
		const files = projectTouchedFiles([tool("Read", "same.ts"), tool("Edit", "same.ts")]);
		expect(files.length).toBe(1);
		expect(files[0].kind).toBe("edit");
	});

	it("Read after Write preserves the `new` marker (new wins over read)", () => {
		const files = projectTouchedFiles([tool("Write", "x.ts"), tool("Read", "x.ts")]);
		expect(files.length).toBe(1);
		expect(files[0].kind).toBe("new");
	});

	it("Write after Read promotes the row to edit (`new` reserved for first-touch writes)", () => {
		const files = projectTouchedFiles([tool("Read", "p.ts"), tool("Write", "p.ts")]);
		expect(files.length).toBe(1);
		expect(files[0].kind).toBe("edit");
	});

	it("READ_TOOLS / EDIT_TOOLS sets match the exact tool names expected", () => {
		expect(READ_TOOLS.has("Read")).toBe(true);
		expect(READ_TOOLS.has("read")).toBe(true);
		expect(READ_TOOLS.has("Edit")).toBe(false);
		expect(EDIT_TOOLS.has("Edit")).toBe(true);
		expect(EDIT_TOOLS.has("Write")).toBe(true);
		expect(EDIT_TOOLS.has("Read")).toBe(false);
	});

	it("toolUsagesToLogItems maps each tool family to its icon kind", () => {
		const items = toolUsagesToLogItems([
			{ name: "Read" },
			{ name: "Edit" },
			{ name: "Write" },
			{ name: "Grep" },
			{ name: "Glob" },
			{ name: "Bash" },
			{ name: "PowerShell" },
			{ name: "Unknown" },
		]);
		expect(items.map((i) => i.kind)).toEqual([
			"read",
			"edit",
			"edit",
			"grep",
			"grep",
			"cmd",
			"cmd",
			"read",
		]);
		// Every label preserved for tooltip.
		expect(items.map((i) => i.label)).toEqual([
			"Read",
			"Edit",
			"Write",
			"Grep",
			"Glob",
			"Bash",
			"PowerShell",
			"Unknown",
		]);
	});
});
