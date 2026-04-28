import { describe, expect, test } from "bun:test";
import * as workflowState from "../../../src/client/state/workflow-state";
import { makeWorkflowState } from "../../helpers";

describe("workflow-state reduce", () => {
	test("workflow:list replaces all workflows and flags affectsCardOrder", () => {
		const state = workflowState.createState();
		workflowState.reduce(state, {
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "old" }),
		});

		const result = workflowState.reduce(state, {
			type: "workflow:list",
			workflows: [makeWorkflowState({ id: "wf-1" }), makeWorkflowState({ id: "wf-2" })],
		});

		expect(state.workflows.size).toBe(2);
		expect(state.workflows.has("old")).toBe(false);
		expect(result.change).toEqual({ notify: true, affectsCardOrder: true });
		expect(result.stateChange).toEqual({ scope: { entity: "global" }, action: "updated" });
	});

	test("workflow:created adds workflow with affectsCardOrder=true", () => {
		const state = workflowState.createState();
		const result = workflowState.reduce(state, {
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "new" }),
		});
		expect(state.workflows.has("new")).toBe(true);
		expect(result.change).toEqual({ notify: true, affectsCardOrder: true });
		expect(result.stateChange).toEqual({
			scope: { entity: "workflow", id: "new" },
			action: "added",
		});
	});

	test("workflow:state with null workflow is a no-op", () => {
		const state = workflowState.createState();
		const result = workflowState.reduce(state, { type: "workflow:state", workflow: null });
		expect(result.change.notify).toBe(false);
		expect(result.change.affectsCardOrder).toBe(false);
	});

	test("workflow:state archived flip triggers card-order rebuild", () => {
		const state = workflowState.createState();
		const wf = makeWorkflowState({ id: "wf-1", archived: false });
		workflowState.reduce(state, { type: "workflow:created", workflow: wf });

		const archived = makeWorkflowState({ id: "wf-1", archived: true });
		const result = workflowState.reduce(state, { type: "workflow:state", workflow: archived });
		expect(result.change.affectsCardOrder).toBe(true);
	});

	test("workflow:state for epic-child sets affectsCardOrder=true", () => {
		const state = workflowState.createState();
		const wf = makeWorkflowState({ id: "wf-1", epicId: "epic-1" });
		workflowState.reduce(state, { type: "workflow:created", workflow: wf });
		const updated = makeWorkflowState({ id: "wf-1", epicId: "epic-1" });
		const result = workflowState.reduce(state, { type: "workflow:state", workflow: updated });
		expect(result.change.affectsCardOrder).toBe(true);
	});

	test("workflow:removed for known workflow notifies + affectsCardOrder", () => {
		const state = workflowState.createState();
		workflowState.reduce(state, {
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		const result = workflowState.reduce(state, { type: "workflow:removed", workflowId: "wf-1" });
		expect(state.workflows.has("wf-1")).toBe(false);
		expect(result.change).toEqual({ notify: true, affectsCardOrder: true });
		expect(result.stateChange).toEqual({
			scope: { entity: "workflow", id: "wf-1" },
			action: "removed",
		});
	});

	test("workflow:removed for unknown workflow emits a warning and does not notify", () => {
		const state = workflowState.createState();
		const result = workflowState.reduce(state, { type: "workflow:removed", workflowId: "ghost" });
		expect(result.change.notify).toBe(false);
		expect(result.warnings?.[0]).toContain("ghost");
	});

	test("workflow:removed clears expandedId/selection drift if it was the expanded one", () => {
		const state = workflowState.createState();
		workflowState.reduce(state, {
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		workflowState.setExpanded(state, "wf-1");
		workflowState.selectStepFor(state, "wf-1", 2);
		workflowState.reduce(state, { type: "workflow:removed", workflowId: "wf-1" });
		expect(state.expandedId).toBeNull();
		expect(state.selectedStepIndex).toBeNull();
		expect(state.selectedStepWorkflowId).toBeNull();
	});

	test("workflow:output appends to outputLines and trims past max", () => {
		const state = workflowState.createState(2);
		workflowState.reduce(state, {
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		workflowState.reduce(state, { type: "workflow:output", workflowId: "wf-1", text: "a" });
		workflowState.reduce(state, { type: "workflow:output", workflowId: "wf-1", text: "b" });
		const r = workflowState.reduce(state, {
			type: "workflow:output",
			workflowId: "wf-1",
			text: "c",
		});
		const wf = state.workflows.get("wf-1");
		expect(wf?.outputLines.length).toBe(2);
		expect((wf?.outputLines[1] as { text: string }).text).toBe("c");
		expect(r.stateChange).toEqual({ scope: { entity: "output", id: "wf-1" }, action: "appended" });
	});

	test("workflow:output for unknown workflow emits a warning", () => {
		const state = workflowState.createState();
		const r = workflowState.reduce(state, {
			type: "workflow:output",
			workflowId: "ghost",
			text: "x",
		});
		expect(r.warnings?.[0]).toContain("workflow:output");
		expect(r.warnings?.[0]).toContain("ghost");
		expect(r.change.notify).toBe(false);
	});

	test("workflow:tools appends a tools entry", () => {
		const state = workflowState.createState();
		workflowState.reduce(state, {
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		const r = workflowState.reduce(state, {
			type: "workflow:tools",
			workflowId: "wf-1",
			tools: [],
		});
		expect(r.change.notify).toBe(true);
		expect(state.workflows.get("wf-1")?.outputLines.at(-1)).toEqual({ kind: "tools", tools: [] });
	});

	test("workflow:tools for unknown workflow emits a warning", () => {
		const state = workflowState.createState();
		const r = workflowState.reduce(state, {
			type: "workflow:tools",
			workflowId: "ghost",
			tools: [],
		});
		expect(r.warnings?.[0]).toContain("workflow:tools");
	});

	test("workflow:question stores the pending question", () => {
		const state = workflowState.createState();
		workflowState.reduce(state, {
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		const r = workflowState.reduce(state, {
			type: "workflow:question",
			workflowId: "wf-1",
			question: { id: "q1", content: "ok?", detectedAt: new Date().toISOString() },
		});
		expect(state.workflows.get("wf-1")?.state.pendingQuestion?.id).toBe("q1");
		expect(r.stateChange).toEqual({
			scope: { entity: "workflow", id: "wf-1" },
			action: "updated",
		});
	});

	test("workflow:question for unknown workflow emits a warning", () => {
		const state = workflowState.createState();
		const r = workflowState.reduce(state, {
			type: "workflow:question",
			workflowId: "ghost",
			question: { id: "q1", content: "ok?", detectedAt: new Date().toISOString() },
		});
		expect(r.warnings?.[0]).toContain("workflow:question");
	});

	test("workflow:step-change updates step + iteration and resets outputLines", () => {
		const state = workflowState.createState();
		workflowState.reduce(state, {
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		const r = workflowState.reduce(state, {
			type: "workflow:step-change",
			workflowId: "wf-1",
			previousStep: null,
			currentStep: "implement",
			currentStepIndex: 2,
			reviewIteration: 3,
		});
		const entry = state.workflows.get("wf-1");
		expect(entry?.state.currentStepIndex).toBe(2);
		expect(entry?.state.reviewCycle.iteration).toBe(3);
		expect(entry?.outputLines.length).toBe(1);
		expect(r.change.notify).toBe(true);
	});

	test("workflow:step-change for unknown workflow emits a warning", () => {
		const state = workflowState.createState();
		const r = workflowState.reduce(state, {
			type: "workflow:step-change",
			workflowId: "ghost",
			previousStep: null,
			currentStep: "implement",
			currentStepIndex: 0,
			reviewIteration: 0,
		});
		expect(r.warnings?.[0]).toContain("workflow:step-change");
	});

	test("epic:dependency-update writes the workflow's dependency status", () => {
		const state = workflowState.createState();
		workflowState.reduce(state, {
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		const r = workflowState.reduce(state, {
			type: "epic:dependency-update",
			workflowId: "wf-1",
			epicDependencyStatus: "satisfied",
			blockingWorkflows: [],
		});
		expect(state.workflows.get("wf-1")?.state.epicDependencyStatus).toBe("satisfied");
		expect(r.change.notify).toBe(true);
	});

	test("epic:dependency-update for unknown workflow emits a warning", () => {
		const state = workflowState.createState();
		const r = workflowState.reduce(state, {
			type: "epic:dependency-update",
			workflowId: "ghost",
			epicDependencyStatus: "satisfied",
			blockingWorkflows: [],
		});
		expect(r.warnings?.[0]).toContain("epic:dependency-update");
	});
});

describe("workflow-state mutators", () => {
	test("selectChild toggles selection and resets step selection", () => {
		const state = workflowState.createState();
		workflowState.selectChild(state, "wf-1");
		expect(state.selectedChildId).toBe("wf-1");
		workflowState.selectStepFor(state, "wf-1", 2);
		workflowState.selectChild(state, "wf-1"); // toggles off
		expect(state.selectedChildId).toBeNull();
		expect(state.selectedStepIndex).toBeNull();
	});

	test("selectStep + selectStepFor + resetStepSelection mutate as expected", () => {
		const state = workflowState.createState();
		workflowState.selectStep(state, 5);
		expect(state.selectedStepIndex).toBe(5);
		workflowState.selectStepFor(state, "wf-1", 7);
		expect(state.selectedStepIndex).toBe(7);
		expect(state.selectedStepWorkflowId).toBe("wf-1");
		workflowState.resetStepSelection(state);
		expect(state.selectedStepIndex).toBeNull();
		expect(state.selectedStepWorkflowId).toBeNull();
	});

	test("setExpanded sets and clears expandedId", () => {
		const state = workflowState.createState();
		workflowState.setExpanded(state, "wf-1");
		expect(state.expandedId).toBe("wf-1");
		workflowState.setExpanded(state, null);
		expect(state.expandedId).toBeNull();
	});

	test("addOrUpdateWorkflow adds a new workflow and flags affectsCardOrder when standalone", () => {
		const state = workflowState.createState();
		const r = workflowState.addOrUpdateWorkflow(state, makeWorkflowState({ id: "wf-1" }));
		expect(state.workflows.has("wf-1")).toBe(true);
		expect(r.change.affectsCardOrder).toBe(true);
		expect(r.stateChange.action).toBe("added");
	});

	test("addOrUpdateWorkflow does not flag affectsCardOrder when updating existing", () => {
		const state = workflowState.createState();
		workflowState.addOrUpdateWorkflow(state, makeWorkflowState({ id: "wf-1" }));
		const r = workflowState.addOrUpdateWorkflow(state, makeWorkflowState({ id: "wf-1" }));
		expect(r.change.affectsCardOrder).toBe(false);
		expect(r.stateChange.action).toBe("updated");
	});

	test("addOrUpdateWorkflow does not flag affectsCardOrder when wf is epic-child", () => {
		const state = workflowState.createState();
		const r = workflowState.addOrUpdateWorkflow(
			state,
			makeWorkflowState({ id: "wf-1", epicId: "epic-1" }),
		);
		expect(r.change.affectsCardOrder).toBe(false);
	});

	test("reset clears all workflow state", () => {
		const state = workflowState.createState();
		workflowState.addOrUpdateWorkflow(state, makeWorkflowState({ id: "wf-1" }));
		workflowState.setExpanded(state, "wf-1");
		workflowState.selectStepFor(state, "wf-1", 2);
		const r = workflowState.reset(state);
		expect(state.workflows.size).toBe(0);
		expect(state.expandedId).toBeNull();
		expect(state.selectedChildId).toBeNull();
		expect(state.selectedStepIndex).toBeNull();
		expect(r.change).toEqual({ notify: true, affectsCardOrder: true });
		expect(r.stateChange.action).toBe("cleared");
	});
});

describe("workflow-state output trimming", () => {
	test("trims to maxOutputLines after appending", () => {
		const state = workflowState.createState(3);
		workflowState.reduce(state, {
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});
		for (let i = 0; i < 10; i++) {
			workflowState.reduce(state, {
				type: "workflow:output",
				workflowId: "wf-1",
				text: `line-${i}`,
			});
		}
		expect(state.workflows.get("wf-1")?.outputLines.length).toBe(3);
		const last = state.workflows.get("wf-1")?.outputLines.at(-1) as { text: string };
		expect(last.text).toBe("line-9");
	});
});
