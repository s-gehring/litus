import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config-store";

const prompt = DEFAULT_CONFIG.prompts.epicDecomposition;

describe("DEFAULT_CONFIG.prompts.epicDecomposition", () => {
	test("preserves the ${epicDescription} substitution exactly once", () => {
		const occurrences = prompt.split("${epicDescription}").length - 1;
		expect(occurrences).toBe(1);
	});

	test("preserves the JSON schema hints", () => {
		expect(prompt).toContain('"title"');
		expect(prompt).toContain('"specs"');
		expect(prompt).toContain('"dependencies"');
	});

	test("contains guidance on self-contained specs", () => {
		expect(prompt).toMatch(/self[- ]contained/i);
	});

	test("contains guidance on independent verifiability", () => {
		expect(prompt).toMatch(/(independently|on its own)[\s\S]{0,40}verif/i);
	});

	test("contains guidance on value", () => {
		expect(prompt).toMatch(/(value|valuable)/i);
	});

	test("discourages scaffolding-only specs (fold-in / avoid phrasing)", () => {
		const foldIn = /(mock|scaffold)[\s\S]{0,80}(fold|combine|merge|consumer|avoid|discourage)/i;
		const reverse = /avoid[\s\S]{0,80}(scaffold|mock)/i;
		expect(foldIn.test(prompt) || reverse.test(prompt)).toBe(true);
	});

	test("acknowledges specs may be substantial in scope", () => {
		expect(prompt).toMatch(/(substantial|large|multi[- ]task|not[\s\S]{0,20}small)/i);
	});

	test("does not instruct 'keep small' or 'smallest possible'", () => {
		expect(prompt).not.toMatch(/keep[\s\S]{0,20}small/i);
		expect(prompt).not.toMatch(/smallest possible/i);
	});

	test("keeps id-naming rule (lowercase letters a, b, c)", () => {
		expect(prompt).toMatch(/a,\s*b,\s*c/);
	});

	test("keeps no-circular-dependency rule", () => {
		expect(prompt).toMatch(/circular/i);
	});
});
