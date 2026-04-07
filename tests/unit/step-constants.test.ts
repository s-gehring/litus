import { describe, expect, test } from "bun:test";
import { PIPELINE_STEP_DEFINITIONS, STEP } from "../../src/types";

describe("STEP constant drift detection", () => {
	test("every PIPELINE_STEP_DEFINITIONS entry has a matching STEP key", () => {
		const stepValues = new Set(Object.values(STEP));
		for (const def of PIPELINE_STEP_DEFINITIONS) {
			expect(stepValues.has(def.name)).toBe(true);
		}
	});

	test("every STEP value exists in PIPELINE_STEP_DEFINITIONS", () => {
		const definedNames = new Set(PIPELINE_STEP_DEFINITIONS.map((d) => d.name));
		for (const value of Object.values(STEP)) {
			expect(definedNames.has(value)).toBe(true);
		}
	});

	test("STEP has exactly as many entries as PIPELINE_STEP_DEFINITIONS", () => {
		expect(Object.keys(STEP).length).toBe(PIPELINE_STEP_DEFINITIONS.length);
	});

	test("all STEP keys follow UPPER_SNAKE_CASE convention", () => {
		for (const key of Object.keys(STEP)) {
			expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
		}
	});
});
