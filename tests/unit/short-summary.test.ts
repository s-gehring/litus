import { describe, expect, test } from "bun:test";
import { shortenSummary } from "../../src/client/short-summary";

describe("shortenSummary", () => {
	test("returns short text unchanged", () => {
		expect(shortenSummary("Add dark mode toggle")).toBe("Add dark mode toggle");
	});

	test("caps at 10 words and appends an ellipsis", () => {
		const text = "one two three four five six seven eight nine ten eleven twelve";
		expect(shortenSummary(text)).toBe("one two three four five six seven eight nine ten…");
	});

	test("caps at 80 characters", () => {
		const text = `${"a".repeat(120)}`;
		const result = shortenSummary(text);
		expect(result.endsWith("…")).toBe(true);
		expect(result.length).toBeLessThanOrEqual(80);
	});

	test("collapses multi-line specs to the first non-empty line", () => {
		const text = "\n\nFirst line that is short\nSecond line with more detail\nThird line";
		expect(shortenSummary(text)).toBe("First line that is short");
	});

	test("collapses runs of whitespace", () => {
		expect(shortenSummary("alpha   beta\tgamma")).toBe("alpha beta gamma");
	});

	test("returns empty string for whitespace-only input", () => {
		expect(shortenSummary("   \n\t  ")).toBe("");
	});

	test("does not append an ellipsis when no truncation happens", () => {
		expect(shortenSummary("Short prompt").endsWith("…")).toBe(false);
	});

	test("handles a long single word by hard-cutting at 80 characters", () => {
		const text = "x".repeat(200);
		const result = shortenSummary(text);
		expect(result.length).toBeLessThanOrEqual(80);
		expect(result.endsWith("…")).toBe(true);
	});
});
