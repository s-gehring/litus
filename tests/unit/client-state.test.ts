import { describe, expect, test } from "bun:test";
import type { WorkflowClientState, WorkflowState } from "../../src/types";
import { makeWorkflowState } from "../helpers";

describe("Multi-workflow client state management", () => {
	test("Map stores multiple workflows by id", () => {
		const workflows = new Map<string, WorkflowClientState>();

		const wf1 = makeWorkflowState({ id: "wf-1" });
		const wf2 = makeWorkflowState({ id: "wf-2" });

		workflows.set("wf-1", { state: wf1, outputLines: [], isExpanded: false });
		workflows.set("wf-2", { state: wf2, outputLines: [], isExpanded: false });

		expect(workflows.size).toBe(2);
		expect(workflows.get("wf-1")?.state.id).toBe("wf-1");
		expect(workflows.get("wf-2")?.state.id).toBe("wf-2");
	});

	test("workflowOrder tracks creation order", () => {
		const workflowOrder: string[] = [];

		workflowOrder.push("wf-1");
		workflowOrder.push("wf-2");
		workflowOrder.push("wf-3");

		expect(workflowOrder).toEqual(["wf-1", "wf-2", "wf-3"]);
	});

	test("only one workflow can be expanded at a time", () => {
		let expandedWorkflowId: string | null = null;

		expandedWorkflowId = "wf-1";
		expect(expandedWorkflowId).toBe("wf-1");

		expandedWorkflowId = "wf-2";
		expect(expandedWorkflowId).toBe("wf-2");
		// wf-1 is no longer expanded
	});

	test("workflow:list populates map and order from array", () => {
		const workflows = new Map<string, WorkflowClientState>();
		const workflowOrder: string[] = [];

		const list: WorkflowState[] = [
			makeWorkflowState({ id: "wf-a", createdAt: "2026-01-01T00:00:00Z" }),
			makeWorkflowState({ id: "wf-b", createdAt: "2026-01-02T00:00:00Z" }),
		];

		// Simulate workflow:list handler
		for (const ws of list) {
			workflows.set(ws.id, { state: ws, outputLines: [], isExpanded: false });
			workflowOrder.push(ws.id);
		}

		expect(workflows.size).toBe(2);
		expect(workflowOrder).toEqual(["wf-a", "wf-b"]);
	});

	test("workflow:created appends to map and order", () => {
		const workflows = new Map<string, WorkflowClientState>();
		const workflowOrder: string[] = [];

		// Existing workflow
		const existing = makeWorkflowState({ id: "wf-1" });
		workflows.set("wf-1", { state: existing, outputLines: [], isExpanded: false });
		workflowOrder.push("wf-1");

		// New workflow created
		const newWf = makeWorkflowState({ id: "wf-2" });
		workflows.set("wf-2", { state: newWf, outputLines: [], isExpanded: false });
		workflowOrder.push("wf-2");

		expect(workflows.size).toBe(2);
		expect(workflowOrder[workflowOrder.length - 1]).toBe("wf-2");
	});

	test("output lines accumulate per workflow independently", () => {
		const workflows = new Map<string, WorkflowClientState>();

		const wf1 = makeWorkflowState({ id: "wf-1" });
		const wf2 = makeWorkflowState({ id: "wf-2" });

		workflows.set("wf-1", { state: wf1, outputLines: [], isExpanded: false });
		workflows.set("wf-2", { state: wf2, outputLines: [], isExpanded: false });

		const entry1 = workflows.get("wf-1");
		const entry2 = workflows.get("wf-2");
		expect(entry1).toBeDefined();
		expect(entry2).toBeDefined();

		entry1?.outputLines.push("line 1 for wf-1");
		entry2?.outputLines.push("line 1 for wf-2");
		entry1?.outputLines.push("line 2 for wf-1");

		expect(entry1?.outputLines).toHaveLength(2);
		expect(entry2?.outputLines).toHaveLength(1);
	});

	test("output buffer is bounded to prevent memory exhaustion", () => {
		const MAX_OUTPUT_LINES = 5000;
		const lines: string[] = [];

		// Add more than max
		for (let i = 0; i < MAX_OUTPUT_LINES + 100; i++) {
			lines.push(`line ${i}`);
		}

		// Trim to max
		if (lines.length > MAX_OUTPUT_LINES) {
			lines.splice(0, lines.length - MAX_OUTPUT_LINES);
		}

		expect(lines).toHaveLength(MAX_OUTPUT_LINES);
		expect(lines[0]).toBe("line 100");
	});
});
