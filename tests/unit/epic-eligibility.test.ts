import { describe, expect, it } from "bun:test";
import { computeEligibleFirstLevelSpecs } from "../../src/epic-eligibility";
import { makeWorkflow } from "../helpers";

describe("computeEligibleFirstLevelSpecs", () => {
	it("matches idle first-level non-archived workflows for the given epic", () => {
		const wf1 = makeWorkflow({
			id: "wf-1",
			epicId: "e-1",
			epicDependencies: [],
			status: "idle",
			archived: false,
		});
		const wf2 = makeWorkflow({
			id: "wf-2",
			epicId: "e-1",
			epicDependencies: [],
			status: "idle",
			archived: false,
		});

		const result = computeEligibleFirstLevelSpecs("e-1", [wf1, wf2]);

		expect(result).toEqual([{ workflowId: "wf-1" }, { workflowId: "wf-2" }]);
	});

	it("rejects workflows whose status is not idle", () => {
		const running = makeWorkflow({
			id: "wf-running",
			epicId: "e-1",
			epicDependencies: [],
			status: "running",
		});
		const completed = makeWorkflow({
			id: "wf-completed",
			epicId: "e-1",
			epicDependencies: [],
			status: "completed",
		});
		const error = makeWorkflow({
			id: "wf-error",
			epicId: "e-1",
			epicDependencies: [],
			status: "error",
		});

		const result = computeEligibleFirstLevelSpecs("e-1", [running, completed, error]);

		expect(result).toEqual([]);
	});

	it("rejects workflows with non-empty epicDependencies", () => {
		const dependent = makeWorkflow({
			id: "wf-dep",
			epicId: "e-1",
			epicDependencies: ["wf-1"],
			status: "idle",
		});

		const result = computeEligibleFirstLevelSpecs("e-1", [dependent]);

		expect(result).toEqual([]);
	});

	it("rejects archived workflows", () => {
		const archived = makeWorkflow({
			id: "wf-archived",
			epicId: "e-1",
			epicDependencies: [],
			status: "idle",
			archived: true,
		});

		const result = computeEligibleFirstLevelSpecs("e-1", [archived]);

		expect(result).toEqual([]);
	});

	it("rejects workflows whose epicId does not match", () => {
		const otherEpic = makeWorkflow({
			id: "wf-other",
			epicId: "e-2",
			epicDependencies: [],
			status: "idle",
		});
		const noEpic = makeWorkflow({
			id: "wf-none",
			epicId: null,
			epicDependencies: [],
			status: "idle",
		});

		const result = computeEligibleFirstLevelSpecs("e-1", [otherEpic, noEpic]);

		expect(result).toEqual([]);
	});

	it("returns an empty array for an empty workflow list", () => {
		expect(computeEligibleFirstLevelSpecs("e-1", [])).toEqual([]);
	});
});
