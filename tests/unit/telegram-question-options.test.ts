import { describe, expect, test } from "bun:test";
import { parseOptionsFromQuestion } from "../../src/telegram/telegram-question-options";

describe("parseOptionsFromQuestion", () => {
	test("parses A/B/C rows", () => {
		const text = [
			"Choose one:",
			"",
			"| Key | Description |",
			"| --- | --- |",
			"| A | Persist mapping |",
			"| B | Fail open |",
			"| C | Retry forever |",
		].join("\n");

		const opts = parseOptionsFromQuestion(text);
		expect(opts).toEqual([
			{ key: "A", description: "Persist mapping" },
			{ key: "B", description: "Fail open" },
			{ key: "C", description: "Retry forever" },
		]);
	});

	test("parses numeric keys", () => {
		const text = [
			"| Option | Description |",
			"| --- | --- |",
			"| 1 | First |",
			"| 2 | Second |",
		].join("\n");
		const opts = parseOptionsFromQuestion(text);
		expect(opts).toEqual([
			{ key: "1", description: "First" },
			{ key: "2", description: "Second" },
		]);
	});

	test("tolerates ragged whitespace", () => {
		const text = ["|Key|Description|", "|---|---|", "|  A  |  spaces around  |", "|B|tight|"].join(
			"\n",
		);
		const opts = parseOptionsFromQuestion(text);
		expect(opts).toEqual([
			{ key: "A", description: "spaces around" },
			{ key: "B", description: "tight" },
		]);
	});

	test("returns null when no markdown table is present", () => {
		const text = "Describe in your own words what you want.";
		expect(parseOptionsFromQuestion(text)).toBeNull();
	});

	test("accepts multi-character keys up to the 24-char wire budget", () => {
		// Five-char keys would have been rejected under the old 4-char cap,
		// silently degrading the question to free-form. The wire-budget cap
		// is ~24 chars after the `q:<UUID36>:` prefix.
		const text = ["| Key | Description |", "| --- | --- |", "| retry | try again |"].join("\n");
		expect(parseOptionsFromQuestion(text)).toEqual([{ key: "retry", description: "try again" }]);
	});

	test("rejects keys exceeding the 24-char wire budget", () => {
		const longKey = "A".repeat(25);
		const text = ["| Key | Description |", "| --- | --- |", `| ${longKey} | way too long |`].join(
			"\n",
		);
		expect(parseOptionsFromQuestion(text)).toBeNull();
	});

	test("returns null when table has only the header (no body rows)", () => {
		const text = ["| Key | Description |", "| --- | --- |"].join("\n");
		expect(parseOptionsFromQuestion(text)).toBeNull();
	});
});
