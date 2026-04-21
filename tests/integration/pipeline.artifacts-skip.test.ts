import { describe, expect, test } from "bun:test";
import { getStepDefinitionsForKind, STEP } from "../../src/types";

describe("US1: artifacts step is not part of non-spec pipelines", () => {
	test("quick-fix step order never includes the artifacts step", () => {
		const names = getStepDefinitionsForKind("quick-fix").map((d) => d.name);
		expect(names).not.toContain(STEP.ARTIFACTS);
	});

	test("quick-fix step order explicitly hops from fix-implement straight to commit-push-pr", () => {
		const names = getStepDefinitionsForKind("quick-fix").map((d) => d.name);
		const fixIdx = names.indexOf(STEP.FIX_IMPLEMENT);
		expect(fixIdx).toBeGreaterThanOrEqual(0);
		expect(names[fixIdx + 1]).toBe(STEP.COMMIT_PUSH_PR);
	});

	test("spec step order places artifacts between implement-review and commit-push-pr", () => {
		const names = getStepDefinitionsForKind("spec").map((d) => d.name);
		const irIdx = names.indexOf(STEP.IMPLEMENT_REVIEW);
		const artIdx = names.indexOf(STEP.ARTIFACTS);
		const cppIdx = names.indexOf(STEP.COMMIT_PUSH_PR);
		expect(irIdx).toBeGreaterThanOrEqual(0);
		expect(artIdx).toBe(irIdx + 1);
		expect(cppIdx).toBe(artIdx + 1);
	});
});
