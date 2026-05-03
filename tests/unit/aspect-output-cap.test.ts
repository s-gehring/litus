import { describe, expect, test } from "bun:test";
import { enforceAspectOutputCap, MAX_ASPECT_OUTPUT_CHARS } from "../../src/pipeline-orchestrator";
import type { OutputEntry } from "../../src/types";

describe("enforceAspectOutputCap", () => {
	test("trims output from the head when over the cap", () => {
		const cap = 10;
		const aspect = {
			output: "0123456789ABCDEF", // 16 chars > 10
			outputLog: [{ kind: "text", text: "0123456789ABCDEF" }] as OutputEntry[],
		};
		enforceAspectOutputCap(aspect, cap);
		expect(aspect.output.length).toBeLessThanOrEqual(cap);
		// Head-trim semantics — keep the tail.
		expect(aspect.output).toBe("6789ABCDEF");
	});

	test("after trim, outputLog text-only character total is at or under the cap", () => {
		const cap = 10;
		const aspect = {
			output: "AAAAABBBBBCCCCCDDDDD", // 20 chars
			outputLog: [
				{ kind: "text", text: "AAAAA" },
				{ kind: "text", text: "BBBBB" },
				{ kind: "text", text: "CCCCC" },
				{ kind: "text", text: "DDDDD" },
			] as OutputEntry[],
		};
		enforceAspectOutputCap(aspect, cap);
		const textTotal = aspect.outputLog
			.filter((e): e is { kind: "text"; text: string } => e.kind === "text")
			.reduce((n, e) => n + e.text.length, 0);
		expect(textTotal).toBeLessThanOrEqual(cap);
	});

	test("tool entries are preserved across a trim (never dropped)", () => {
		const cap = 5;
		const aspect = {
			output: "AAAAABBBBB", // 10 chars > cap
			outputLog: [
				{ kind: "text", text: "AAAAA" },
				{ kind: "tools", tools: [{ name: "Read" }] },
				{ kind: "text", text: "BBBBB" },
				{ kind: "tools", tools: [{ name: "Edit" }] },
			] as OutputEntry[],
		};
		enforceAspectOutputCap(aspect, cap);
		const toolEntries = aspect.outputLog.filter((e) => e.kind === "tools");
		expect(toolEntries.length).toBe(2);
	});

	test("idempotent on already-compliant input", () => {
		const aspect = {
			output: "small",
			outputLog: [
				{ kind: "text", text: "small" },
				{ kind: "tools", tools: [{ name: "Read" }] },
			] as OutputEntry[],
		};
		const before = JSON.stringify(aspect);
		enforceAspectOutputCap(aspect, 100);
		expect(JSON.stringify(aspect)).toBe(before);
		// Second invocation continues to be a no-op.
		enforceAspectOutputCap(aspect, 100);
		expect(JSON.stringify(aspect)).toBe(before);
	});

	test("MAX_ASPECT_OUTPUT_CHARS default is exposed and positive", () => {
		expect(MAX_ASPECT_OUTPUT_CHARS).toBeGreaterThan(0);
		const aspect = {
			output: "tiny",
			outputLog: [{ kind: "text", text: "tiny" }] as OutputEntry[],
		};
		// Default cap (no second arg) shouldn't trim anything for tiny input.
		enforceAspectOutputCap(aspect);
		expect(aspect.output).toBe("tiny");
	});
});
