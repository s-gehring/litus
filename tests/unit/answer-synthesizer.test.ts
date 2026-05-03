import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildFeedbackPreamble,
	buildSynthesisPrompt,
	readSynthesizedAnswer,
} from "../../src/answer-synthesizer";

describe("buildSynthesisPrompt", () => {
	test("substitutes ${question}, ${aspectFindings}, ${answerFileName}", () => {
		const out = buildSynthesisPrompt("Q: ${question}\nF: ${aspectFindings}\nA: ${answerFileName}", {
			question: "Why?",
			aspectFindings: "findings...",
			answerFileName: "answer.md",
		});
		expect(out).toBe("Q: Why?\nF: findings...\nA: answer.md");
	});
});

describe("buildFeedbackPreamble", () => {
	test("includes the previous answer + feedback in a fixed structure", () => {
		const out = buildFeedbackPreamble("# old\nold body", "make it shorter");
		expect(out).toContain("PREVIOUS ANSWER:");
		expect(out).toContain("# old\nold body");
		expect(out).toContain("USER FEEDBACK:");
		expect(out).toContain("make it shorter");
	});
});

describe("readSynthesizedAnswer", () => {
	test("returns ok with markdown + sourceFileName when file is non-empty", () => {
		const dir = mkdtempSync(join(tmpdir(), "ask-q-test-"));
		try {
			writeFileSync(join(dir, "answer.md"), "# Answer\n\nbody");
			const r = readSynthesizedAnswer(dir, "answer.md");
			expect(r.kind).toBe("ok");
			if (r.kind === "ok") {
				expect(r.answer.markdown).toBe("# Answer\n\nbody");
				expect(r.answer.sourceFileName).toBe("answer.md");
				expect(r.answer.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns missing when the file does not exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "ask-q-test-"));
		try {
			expect(readSynthesizedAnswer(dir, "answer.md").kind).toBe("missing");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns empty when the file has only whitespace", () => {
		const dir = mkdtempSync(join(tmpdir(), "ask-q-test-"));
		try {
			writeFileSync(join(dir, "answer.md"), "   \n\n");
			expect(readSynthesizedAnswer(dir, "answer.md").kind).toBe("empty");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
