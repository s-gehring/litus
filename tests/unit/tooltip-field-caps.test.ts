import { describe, expect, test } from "bun:test";
import {
	abbreviateField,
	formatToolInput,
	TOOLTIP_FIELD_CAPS,
} from "../../src/client/components/workflow-window";

describe("abbreviateField", () => {
	test("content within cap renders uncut with no truncation marker", () => {
		const content = "line1\nline2\nline3";
		const result = abbreviateField(content, TOOLTIP_FIELD_CAPS.commandOrArgument);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe(content);
		expect(result.remaining).toBe(0);
	});

	test("command >30 lines abbreviates with trailing '… (N more lines)' marker", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`);
		const content = lines.join("\n");
		const result = abbreviateField(content, TOOLTIP_FIELD_CAPS.commandOrArgument);
		expect(result.truncated).toBe(true);
		expect(result.remaining).toBe(20);
		expect(result.text.startsWith("line1\n")).toBe(true);
		expect(result.text.endsWith("… (20 more lines)")).toBe(true);
		const beforeMarker = result.text.slice(0, result.text.lastIndexOf("\n"));
		expect(beforeMarker.split("\n")).toHaveLength(TOOLTIP_FIELD_CAPS.commandOrArgument);
	});

	test("Write body >15 lines abbreviates at the lower cap", () => {
		const lines = Array.from({ length: 25 }, (_, i) => `l${i}`);
		const content = lines.join("\n");
		const result = abbreviateField(content, TOOLTIP_FIELD_CAPS.writeBody);
		expect(result.truncated).toBe(true);
		expect(result.remaining).toBe(10);
		expect(result.text.endsWith("… (10 more lines)")).toBe(true);
	});

	test("uncapped field (cap=null) returns full content untouched", () => {
		const content = Array.from({ length: 1000 }, (_, i) => `m${i}`).join("\n");
		const result = abbreviateField(content, null);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe(content);
	});

	test("empty content produces no truncation marker", () => {
		const result = abbreviateField("", TOOLTIP_FIELD_CAPS.writeBody);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("");
		expect(result.remaining).toBe(0);
	});

	test("exactly at the cap is not truncated", () => {
		const content = Array.from({ length: TOOLTIP_FIELD_CAPS.commandOrArgument }, (_, i) =>
			String(i),
		).join("\n");
		const result = abbreviateField(content, TOOLTIP_FIELD_CAPS.commandOrArgument);
		expect(result.truncated).toBe(false);
	});

	test("remaining=1 uses singular 'line' in the marker", () => {
		const content = Array.from({ length: TOOLTIP_FIELD_CAPS.writeBody + 1 }, (_, i) =>
			String(i),
		).join("\n");
		const result = abbreviateField(content, TOOLTIP_FIELD_CAPS.writeBody);
		expect(result.text.endsWith("… (1 more line)")).toBe(true);
	});
});

describe("formatToolInput", () => {
	test("Write with long content applies the lower writeBody cap to `content`", () => {
		const longBody = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
		const out = formatToolInput("Write", { file_path: "/tmp/x.txt", content: longBody });
		expect(out).toContain("file_path: /tmp/x.txt");
		expect(out).toContain(`… (${30 - TOOLTIP_FIELD_CAPS.writeBody} more lines)`);
	});

	test("Bash with long command applies the commandOrArgument cap", () => {
		const longCmd = Array.from({ length: 50 }, (_, i) => `echo ${i}`).join("\n");
		const out = formatToolInput("Bash", { command: longCmd });
		expect(out).toContain(`… (${50 - TOOLTIP_FIELD_CAPS.commandOrArgument} more lines)`);
	});

	test("Edit old_string/new_string use the commandOrArgument cap, not writeBody", () => {
		const body = Array.from({ length: 20 }, (_, i) => `x${i}`).join("\n");
		const out = formatToolInput("Edit", { old_string: body, new_string: body });
		// 20 lines is below commandOrArgument (30) but above writeBody (15):
		// should NOT be truncated, proving Edit is NOT treated as a write body.
		expect(out).not.toContain("more lines");
		expect(out).not.toContain("more line)");
	});

	test("Write with empty content still emits the field without a truncation marker", () => {
		const out = formatToolInput("Write", { file_path: "/tmp/y", content: "" });
		expect(out).toContain("content: ");
		expect(out).not.toContain("more line");
	});

	test("uncapped fields (file_path) are never truncated even if huge", () => {
		const hugePath = Array.from({ length: 500 }, (_, i) => `seg${i}`).join("/");
		const out = formatToolInput("Read", { file_path: hugePath });
		expect(out).toContain(hugePath);
	});
});
