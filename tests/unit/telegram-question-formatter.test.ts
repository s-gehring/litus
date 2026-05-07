import { describe, expect, test } from "bun:test";
import {
	formatQuestionForTelegram,
	splitForTelegram,
	TELEGRAM_TEXT_LIMIT,
} from "../../src/telegram/telegram-question-formatter";

describe("formatQuestionForTelegram", () => {
	test("multi-choice question produces one button per option, key-only labels", () => {
		const out = formatQuestionForTelegram("q1", "Pick one", [
			{ key: "A", description: "Option A description" },
			{ key: "B", description: "Option B description" },
		]);
		expect(out.chunks).toEqual(["Pick one"]);
		expect(out.replyMarkup).not.toBeNull();
		const keyboard = out.replyMarkup?.inline_keyboard;
		expect(keyboard).toEqual([
			[{ text: "A", callback_data: "q:q1:A" }],
			[{ text: "B", callback_data: "q:q1:B" }],
		]);
	});

	test("free-form question (null options) produces no keyboard", () => {
		const out = formatQuestionForTelegram("q1", "Describe yourself", null);
		expect(out.replyMarkup).toBeNull();
	});

	test("empty options array produces no keyboard (free-form path)", () => {
		const out = formatQuestionForTelegram("q1", "Describe yourself", []);
		expect(out.replyMarkup).toBeNull();
	});

	test("HTML special characters in body are escaped", () => {
		const out = formatQuestionForTelegram("q1", "<b>boom</b> & cheers", null);
		expect(out.chunks[0]).toBe("&lt;b&gt;boom&lt;/b&gt; &amp; cheers");
	});
});

describe("splitForTelegram (FR-010 split logic)", () => {
	test("text within the limit returns one chunk", () => {
		const text = "x".repeat(TELEGRAM_TEXT_LIMIT - 1);
		expect(splitForTelegram(text)).toEqual([text]);
	});

	test("exactly-at-limit returns one chunk", () => {
		const text = "x".repeat(TELEGRAM_TEXT_LIMIT);
		expect(splitForTelegram(text)).toEqual([text]);
	});

	test("just-over-limit splits into two chunks", () => {
		const text = "x".repeat(TELEGRAM_TEXT_LIMIT + 100);
		const chunks = splitForTelegram(text);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
		expect(chunks.join("")).toBe(text);
	});

	test("multi-split: 3× limit produces ≥ 3 chunks, all ≤ limit, concat preserves text", () => {
		const text = "y".repeat(TELEGRAM_TEXT_LIMIT * 3 + 50);
		const chunks = splitForTelegram(text);
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
		expect(chunks.join("")).toBe(text);
	});

	test("prefers double-newline boundary when available within window", () => {
		const partA = "a".repeat(TELEGRAM_TEXT_LIMIT - 200);
		const partB = "b".repeat(500);
		const text = `${partA}\n\n${partB}`;
		const chunks = splitForTelegram(text);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		// First chunk ends after the double newline.
		expect(chunks[0].endsWith("\n\n")).toBe(true);
		expect(chunks.join("")).toBe(text);
	});
});

describe("formatQuestionForTelegram + split (US3 invariant: keyboard caller-attaches to last chunk)", () => {
	test("body that exceeds limit produces multiple chunks; keyboard returned once", () => {
		const big = "z".repeat(TELEGRAM_TEXT_LIMIT * 2 + 10);
		const out = formatQuestionForTelegram("q1", big, [{ key: "A", description: "A" }]);
		expect(out.chunks.length).toBeGreaterThanOrEqual(2);
		expect(out.replyMarkup).not.toBeNull();
		// Caller is responsible for attaching the keyboard to the last chunk only,
		// but the formatter must surface a single keyboard regardless of chunk
		// count — it must NOT return one keyboard per chunk.
		const keyboard = out.replyMarkup?.inline_keyboard;
		expect(Array.isArray(keyboard)).toBe(true);
	});

	test("body just over limit produces 2 chunks; concatenation reproduces text", () => {
		const text = "x".repeat(TELEGRAM_TEXT_LIMIT + 1);
		const out = formatQuestionForTelegram("q1", text, null);
		expect(out.chunks.length).toBeGreaterThanOrEqual(2);
		expect(out.chunks.join("")).toBe(text);
	});
});
