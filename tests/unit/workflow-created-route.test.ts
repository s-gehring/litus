import { describe, expect, test } from "bun:test";
import { workflowCreatedTarget } from "../../src/client/components/workflow-created-route";

describe("workflowCreatedTarget", () => {
	test("navigates into the new workflow when standalone and on dashboard", () => {
		expect(workflowCreatedTarget({ id: "wf-1" }, "/")).toBe("/workflow/wf-1");
	});

	test("navigates into the new workflow when currentPath is null (pre-router boot)", () => {
		expect(workflowCreatedTarget({ id: "wf-1" }, null)).toBe("/workflow/wf-1");
	});

	test("does not navigate when the workflow belongs to an epic", () => {
		expect(workflowCreatedTarget({ id: "wf-1", epicId: "epic-9" }, "/")).toBeNull();
	});

	test("does not steal focus from the config page", () => {
		expect(workflowCreatedTarget({ id: "wf-1" }, "/config")).toBeNull();
	});

	test("does not steal focus from an /epic/:id view", () => {
		expect(workflowCreatedTarget({ id: "wf-1" }, "/epic/epic-42")).toBeNull();
	});

	test("does not steal focus from /epic/:id even when the new workflow is epic-less", () => {
		expect(workflowCreatedTarget({ id: "wf-1", epicId: null }, "/epic/epic-42")).toBeNull();
	});

	test("epic-child workflow created while user is on its sibling workflow — stays put", () => {
		expect(
			workflowCreatedTarget({ id: "wf-2", epicId: "epic-1" }, "/workflow/wf-other"),
		).toBeNull();
	});

	test("standalone workflow created while user is on another workflow — replaces focus", () => {
		// This matches the long-standing auto-navigate behaviour for standalone
		// broadcasts; guarded by the dashboard-only rule at the call-site in app.ts
		// only for the `workflow:list` case, not this one.
		expect(workflowCreatedTarget({ id: "wf-new" }, "/workflow/wf-other")).toBe("/workflow/wf-new");
	});
});
