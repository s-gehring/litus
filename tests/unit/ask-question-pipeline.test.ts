import { describe, expect, test } from "bun:test";
import { getStepDefinitionsForKind, STEP } from "../../src/pipeline-steps";

describe("ask-question pipeline order", () => {
	test("getStepDefinitionsForKind('ask-question') returns the expected order", () => {
		const defs = getStepDefinitionsForKind("ask-question");
		const names = defs.map((d) => d.name);
		expect(names).toEqual([
			STEP.SETUP,
			STEP.DECOMPOSE,
			STEP.RESEARCH_ASPECT,
			STEP.SYNTHESIZE,
			STEP.ANSWER,
			STEP.FINALIZE,
		]);
	});

	test("ask-question pipeline does NOT include any commit/PR/CI steps", () => {
		const names = new Set(getStepDefinitionsForKind("ask-question").map((d) => d.name));
		expect(names.has(STEP.COMMIT_PUSH_PR)).toBe(false);
		expect(names.has(STEP.MONITOR_CI)).toBe(false);
		expect(names.has(STEP.MERGE_PR)).toBe(false);
		expect(names.has(STEP.SYNC_REPO)).toBe(false);
	});

	test("display names are user-facing strings", () => {
		const defs = getStepDefinitionsForKind("ask-question");
		const byName = new Map(defs.map((d) => [d.name, d.displayName]));
		expect(byName.get(STEP.DECOMPOSE)).toBe("Decomposing Question");
		expect(byName.get(STEP.RESEARCH_ASPECT)).toBe("Researching Aspect");
		expect(byName.get(STEP.SYNTHESIZE)).toBe("Synthesizing Answer");
		expect(byName.get(STEP.ANSWER)).toBe("Answer");
		expect(byName.get(STEP.FINALIZE)).toBe("Finalizing");
	});
});
