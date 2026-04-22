import { describe, expect, it } from "bun:test";
import {
	displayToFullModelId,
	fullToDisplayModelId,
	projectRunScreenModel,
} from "../../../src/client/components/run-screen/project-run-screen";
import type { AppConfig, ToolUsage, WorkflowClientState } from "../../../src/types";
import { makeWorkflowState } from "../../helpers";
import { makeAppConfig } from "../../test-infra/factories";

function entryFor(over: Partial<WorkflowClientState["state"]> = {}): WorkflowClientState {
	return { state: makeWorkflowState(over), outputLines: [] };
}

describe("displayToFullModelId / fullToDisplayModelId", () => {
	it("round-trips the three display ids through the full-id table", () => {
		expect(fullToDisplayModelId(displayToFullModelId("haiku-4"))).toBe("haiku-4");
		expect(fullToDisplayModelId(displayToFullModelId("sonnet-4.5"))).toBe("sonnet-4.5");
		expect(fullToDisplayModelId(displayToFullModelId("opus-4.7"))).toBe("opus-4.7");
	});

	it("fullToDisplayModelId matches the three supported families through full-id patterns", () => {
		expect(fullToDisplayModelId("claude-sonnet-4-5-20250929")).toBe("sonnet-4.5");
		expect(fullToDisplayModelId("claude-haiku-4-5-20251001")).toBe("haiku-4");
		expect(fullToDisplayModelId("claude-opus-4-7")).toBe("opus-4.7");
	});

	it("fullToDisplayModelId returns null for unrecognised ids (§2.4)", () => {
		// Older sonnet stamp that the new segmented picker does not represent.
		expect(fullToDisplayModelId("claude-3-5-sonnet-20241022")).toBeNull();
		// Wholly unrelated custom id.
		expect(fullToDisplayModelId("my-internal-model")).toBeNull();
		// Empty string.
		expect(fullToDisplayModelId("")).toBeNull();
	});

	it("displayToFullModelId returns the input when given an unknown id", () => {
		expect(displayToFullModelId("random")).toBe("random");
	});
});

describe("projectRunScreenModel", () => {
	it("translates the AppConfig full model id into the picker's display id (§1.7)", () => {
		const config: AppConfig = makeAppConfig({
			models: {
				...makeAppConfig().models,
				implement: "claude-opus-4-7",
				specify: "claude-haiku-4-5-20251001",
			},
		});
		const qf = projectRunScreenModel(entryFor({ workflowKind: "quick-fix" }), { config });
		expect(qf.config.model).toBe("opus-4.7");

		const sp = projectRunScreenModel(entryFor({ workflowKind: "spec" }), { config });
		expect(sp.config.model).toBe("haiku-4");
	});

	it("empty model slot paints no selection (null) rather than silently defaulting", () => {
		const config: AppConfig = makeAppConfig({
			models: { ...makeAppConfig().models, implement: "" },
		});
		const projected = projectRunScreenModel(entryFor({ workflowKind: "quick-fix" }), { config });
		expect(projected.config.model).toBeNull();
	});

	it("unknown full-id maps to null, not sonnet-4.5 (§2.4 — no silent coercion)", () => {
		const config: AppConfig = makeAppConfig({
			models: { ...makeAppConfig().models, implement: "claude-3-5-sonnet-20241022" },
		});
		const projected = projectRunScreenModel(entryFor({ workflowKind: "quick-fix" }), { config });
		expect(projected.config.model).toBeNull();
	});

	it("honours xhigh/max effort values from config (no silent collapse)", () => {
		const config: AppConfig = makeAppConfig({
			efforts: { ...makeAppConfig().efforts, implement: "xhigh", specify: "max" },
		});
		expect(
			projectRunScreenModel(entryFor({ workflowKind: "quick-fix" }), { config }).config.effort,
		).toBe("xhigh");
		expect(
			projectRunScreenModel(entryFor({ workflowKind: "spec" }), { config }).config.effort,
		).toBe("max");
	});

	it("tool counters use READ_TOOLS/EDIT_TOOLS sets — not substring match (§4.5)", () => {
		// A made-up tool whose name contains the substring "read" but isn't a
		// real read tool must NOT inflate the counter. The fixed projection
		// keys off the exact READ_TOOLS set.
		const fakeRead: ToolUsage = { name: "UnrelatedReadLike" };
		const realRead: ToolUsage = { name: "Read", input: { file_path: "a.ts" } };
		const realEdit: ToolUsage = { name: "Edit", input: { file_path: "b.ts" } };

		const state = makeWorkflowState({
			steps: [
				{
					name: "implement",
					displayName: "Implementing",
					status: "running",
					output: "",
					outputLog: [{ kind: "tools", tools: [fakeRead, realRead, realEdit] }],
					error: null,
					startedAt: null,
					completedAt: null,
					history: [],
				},
			],
		});
		const projected = projectRunScreenModel({ state, outputLines: [] }, { config: null });
		expect(projected.log.counters.reads).toBe(1);
		expect(projected.log.counters.edits).toBe(1);
		expect(projected.log.counters.toolCalls).toBe(3);
	});

	it("null config → no model painted, effort defaults to medium (§2.4)", () => {
		const projected = projectRunScreenModel(entryFor(), { config: null });
		expect(projected.config.model).toBeNull();
		expect(projected.config.effort).toBe("medium");
	});

	it("forwards basic workflow identity fields onto the RunScreenModel", () => {
		const state = makeWorkflowState({
			id: "wf-42",
			summary: "Fix the thing",
			workflowKind: "quick-fix",
			status: "running",
		});
		const projected = projectRunScreenModel({ state, outputLines: [] }, { config: null });
		expect(projected.id).toBe("wf-42");
		expect(projected.title).toBe("Fix the thing");
		expect(projected.type).toBe("quickfix");
		expect(projected.state).toBe("running");
	});
});
