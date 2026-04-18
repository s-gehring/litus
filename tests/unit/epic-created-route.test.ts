import { describe, expect, test } from "bun:test";
import { epicCreatedTarget } from "../../src/client/components/epic-created-route";

describe("epicCreatedTarget", () => {
	test("navigates into the new epic when on dashboard", () => {
		expect(epicCreatedTarget("epic-1", "/")).toBe("/epic/epic-1");
	});

	test("navigates into the new epic when currentPath is null (pre-router boot)", () => {
		expect(epicCreatedTarget("epic-1", null)).toBe("/epic/epic-1");
	});

	test("does not steal focus from the config page", () => {
		expect(epicCreatedTarget("epic-1", "/config")).toBeNull();
	});

	test("does not steal focus from another /epic/:id view", () => {
		expect(epicCreatedTarget("epic-new", "/epic/epic-existing")).toBeNull();
	});

	test("navigates when viewing a standalone workflow (no epic focus to preserve)", () => {
		// Mirrors workflowCreatedTarget's rule at line 39 of its test file: a
		// standalone-epic broadcast while the user is on a workflow view still
		// replaces focus, since the user is not inside an epic.
		expect(epicCreatedTarget("epic-new", "/workflow/wf-other")).toBe("/epic/epic-new");
	});
});
