import { describe, expect, it } from "bun:test";
import {
	stepStateFromStatus,
	taskStateFromStatus,
	taskTypeFromWorkflow,
} from "../../../src/client/components/run-screen/run-screen-model";
import type { WorkflowState } from "../../../src/types";
import { makeWorkflowState } from "../../helpers";

describe("taskStateFromStatus", () => {
	it("maps each WorkflowStatus to the intended TaskState", () => {
		expect(taskStateFromStatus("running")).toBe("running");
		expect(taskStateFromStatus("paused")).toBe("paused");
		expect(taskStateFromStatus("waiting_for_input")).toBe("paused");
		expect(taskStateFromStatus("completed")).toBe("done");
		expect(taskStateFromStatus("error")).toBe("error");
		expect(taskStateFromStatus("aborted")).toBe("error");
		expect(taskStateFromStatus("waiting_for_dependencies")).toBe("blocked");
		expect(taskStateFromStatus("idle")).toBe("queued");
	});
});

describe("stepStateFromStatus", () => {
	it("maps running/completed to their explicit states", () => {
		expect(stepStateFromStatus("running")).toBe("running");
		expect(stepStateFromStatus("completed")).toBe("done");
	});

	it("collapses every other status to queued (§2.10 decision)", () => {
		expect(stepStateFromStatus("pending")).toBe("queued");
		expect(stepStateFromStatus("paused")).toBe("queued");
		expect(stepStateFromStatus("waiting_for_input")).toBe("queued");
		expect(stepStateFromStatus("error")).toBe("queued");
	});
});

describe("taskTypeFromWorkflow", () => {
	function wfWith(over: Partial<WorkflowState>): WorkflowState {
		return makeWorkflowState(over);
	}

	it("epicId wins over workflowKind → always epic", () => {
		expect(taskTypeFromWorkflow(wfWith({ epicId: "ep-1", workflowKind: "quick-fix" }))).toBe(
			"epic",
		);
		expect(taskTypeFromWorkflow(wfWith({ epicId: "ep-1", workflowKind: "spec" }))).toBe("epic");
	});

	it("quick-fix without epic → quickfix", () => {
		expect(taskTypeFromWorkflow(wfWith({ epicId: null, workflowKind: "quick-fix" }))).toBe(
			"quickfix",
		);
	});

	it("spec without epic → spec", () => {
		expect(taskTypeFromWorkflow(wfWith({ epicId: null, workflowKind: "spec" }))).toBe("spec");
	});
});
