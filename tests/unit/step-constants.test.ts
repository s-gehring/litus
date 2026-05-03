import { describe, expect, test } from "bun:test";
import {
	getStepDefinitionsForKind,
	PIPELINE_STEP_DEFINITIONS,
	type PipelineStepName,
	STEP,
} from "../../src/pipeline-steps";

describe("STEP constant drift detection", () => {
	test("every PIPELINE_STEP_DEFINITIONS entry has a matching STEP key", () => {
		const stepValues: Set<PipelineStepName> = new Set(Object.values(STEP));
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

	test("every defined step appears in SPEC_ORDER, QUICK_FIX_ORDER, or ASK_QUESTION_ORDER", () => {
		const reachable = new Set<PipelineStepName>([
			...getStepDefinitionsForKind("spec").map((d) => d.name),
			...getStepDefinitionsForKind("quick-fix").map((d) => d.name),
			...getStepDefinitionsForKind("ask-question").map((d) => d.name),
		]);
		for (const def of PIPELINE_STEP_DEFINITIONS) {
			expect(reachable.has(def.name)).toBe(true);
		}
	});

	// Compile-time assertion that the `PipelineStepName` union is *exactly* the
	// set of `STEP` values. `STEP satisfies Record<string, PipelineStepName>`
	// already enforces one direction (every STEP value is a valid name); this
	// adds the reverse so a literal added to `PipelineStepName` without a
	// corresponding `STEP` entry fails to type-check.
	type _StepValues = (typeof STEP)[keyof typeof STEP];
	type _Equal<A, B> =
		(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
	type _StepNamesMatchStepValues = _Equal<PipelineStepName, _StepValues>;
	const _stepNamesMatchStepValues: _StepNamesMatchStepValues = true;
	void _stepNamesMatchStepValues;
});
