import type { OutputEntry, ServerMessage, WorkflowClientState, WorkflowState } from "../../types";
import { DEFAULT_MAX_OUTPUT_LINES, type ReducerResult, type WorkflowSliceState } from "./types";

const WORKFLOW_OWNED = [
	"workflow:list",
	"workflow:created",
	"workflow:state",
	"workflow:removed",
	"workflow:output",
	"workflow:tools",
	"workflow:aspect:output",
	"workflow:aspect:tools",
	"workflow:aspect:state",
	"workflow:question",
	"workflow:step-change",
	"epic:dependency-update",
] as const;

export type WorkflowOwnedType = (typeof WORKFLOW_OWNED)[number];
export const OWNED_TYPES: ReadonlySet<WorkflowOwnedType> = new Set(WORKFLOW_OWNED);
export type WorkflowSliceMessage = Extract<ServerMessage, { type: WorkflowOwnedType }>;

type Result = ReducerResult<WorkflowSliceState>;
type Msg<T extends WorkflowOwnedType> = Extract<WorkflowSliceMessage, { type: T }>;

export function createState(maxOutputLines: number = DEFAULT_MAX_OUTPUT_LINES): WorkflowSliceState {
	return {
		workflows: new Map<string, WorkflowClientState>(),
		selectedChildId: null,
		selectedStepIndex: null,
		selectedStepWorkflowId: null,
		expandedId: null,
		maxOutputLines,
	};
}

export function setMaxOutputLines(state: WorkflowSliceState, max: number): WorkflowSliceState {
	state.maxOutputLines = max;
	return state;
}

export function reduce(state: WorkflowSliceState, message: WorkflowSliceMessage): Result {
	switch (message.type) {
		case "workflow:list":
			return handleList(state, message);
		case "workflow:created":
			return handleCreated(state, message);
		case "workflow:state":
			return handleState(state, message);
		case "workflow:removed":
			return handleRemoved(state, message);
		case "workflow:output":
			return appendOutput(
				state,
				message.workflowId,
				{ kind: "text", text: message.text },
				"output",
			);
		case "workflow:tools":
			return appendOutput(
				state,
				message.workflowId,
				{ kind: "tools", tools: message.tools },
				"tools",
			);
		case "workflow:aspect:output":
			return appendAspectEntry(state, message.workflowId, message.aspectId, {
				kind: "text",
				text: message.text,
			});
		case "workflow:aspect:tools":
			return appendAspectEntry(state, message.workflowId, message.aspectId, {
				kind: "tools",
				tools: message.tools,
			});
		case "workflow:aspect:state":
			return handleAspectState(state, message);
		case "workflow:question":
			return mutateWorkflow(state, message.workflowId, "workflow:question", (entry) => {
				entry.state.pendingQuestion = message.question;
			});
		case "workflow:step-change":
			return handleStepChange(state, message);
		case "epic:dependency-update":
			return mutateWorkflow(state, message.workflowId, "epic:dependency-update", (entry) => {
				entry.state.epicDependencyStatus = message.epicDependencyStatus;
			});
	}
}

// Reducer helpers ----------------------------------------------------------

function noNotify(state: WorkflowSliceState): Result {
	return {
		state,
		change: { notify: false, affectsCardOrder: false },
		stateChange: { scope: { entity: "none" }, action: "updated" },
	};
}

function unknownId(state: WorkflowSliceState, msgType: string, id: string): Result {
	return {
		state,
		change: { notify: false, affectsCardOrder: false },
		stateChange: { scope: { entity: "none" }, action: "updated" },
		warnings: [`${msgType} for unknown workflowId '${id}'`],
	};
}

/** Look up a workflow, mutate it via `mutate`, and return a notify-only result. */
function mutateWorkflow(
	state: WorkflowSliceState,
	workflowId: string,
	msgType: string,
	mutate: (entry: WorkflowClientState) => void,
): Result {
	const entry = state.workflows.get(workflowId);
	if (!entry) return unknownId(state, msgType, workflowId);
	mutate(entry);
	return {
		state,
		change: { notify: true, affectsCardOrder: false },
		stateChange: { scope: { entity: "workflow", id: workflowId }, action: "updated" },
	};
}

function appendOutput(
	state: WorkflowSliceState,
	workflowId: string,
	out: OutputEntry,
	msgType: "output" | "tools",
): Result {
	const entry = state.workflows.get(workflowId);
	if (!entry) return unknownId(state, `workflow:${msgType}`, workflowId);
	entry.outputLines.push(out);
	trimOutput(entry.outputLines, state.maxOutputLines);
	return {
		state,
		change: { notify: true, affectsCardOrder: false },
		stateChange: { scope: { entity: "output", id: workflowId }, action: "appended" },
	};
}

function appendAspectEntry(
	state: WorkflowSliceState,
	workflowId: string,
	aspectId: string,
	entry: OutputEntry,
): Result {
	const wfEntry = state.workflows.get(workflowId);
	if (!wfEntry) return unknownId(state, "workflow:aspect:*", workflowId);
	const aspect = wfEntry.state.aspects?.find((a) => a.id === aspectId);
	if (!aspect) {
		return {
			state,
			change: { notify: false, affectsCardOrder: false },
			stateChange: { scope: { entity: "none" }, action: "updated" },
			warnings: [
				`workflow:aspect:* for unknown aspectId '${aspectId}' on workflow '${workflowId}'`,
			],
		};
	}
	if (entry.kind === "text") aspect.output += entry.text;
	aspect.outputLog.push(entry);
	return {
		state,
		change: { notify: true, affectsCardOrder: false },
		stateChange: { scope: { entity: "workflow", id: workflowId }, action: "appended" },
	};
}

function handleAspectState(state: WorkflowSliceState, msg: Msg<"workflow:aspect:state">): Result {
	const entry = state.workflows.get(msg.workflowId);
	if (!entry) return unknownId(state, "workflow:aspect:state", msg.workflowId);
	const aspects = entry.state.aspects;
	if (!aspects) return unknownId(state, "workflow:aspect:state", msg.workflowId);
	const idx = aspects.findIndex((a) => a.id === msg.aspectId);
	if (idx < 0) {
		return {
			state,
			change: { notify: false, affectsCardOrder: false },
			stateChange: { scope: { entity: "none" }, action: "updated" },
			warnings: [
				`workflow:aspect:state for unknown aspectId '${msg.aspectId}' on workflow '${msg.workflowId}'`,
			],
		};
	}
	const local = aspects[idx];
	// Per contract §1.3: if state.outputLog is non-empty, replace the local
	// mirror (handles late-joiner / server-restart). If empty AND the local
	// mirror has data, preserve it and only update structural fields.
	if (msg.state.outputLog.length > 0) {
		aspects[idx] = msg.state;
	} else if (local.outputLog.length > 0) {
		aspects[idx] = {
			...msg.state,
			output: local.output,
			outputLog: local.outputLog,
		};
	} else {
		aspects[idx] = msg.state;
	}
	return {
		state,
		change: { notify: true, affectsCardOrder: false },
		stateChange: { scope: { entity: "workflow", id: msg.workflowId }, action: "updated" },
	};
}

// Per-message handlers -----------------------------------------------------

function handleList(state: WorkflowSliceState, msg: Msg<"workflow:list">): Result {
	state.workflows.clear();
	for (const wf of msg.workflows) insertOrUpdateWorkflow(state, wf);
	return {
		state,
		change: { notify: true, affectsCardOrder: true },
		stateChange: { scope: { entity: "global" }, action: "updated" },
	};
}

function handleCreated(state: WorkflowSliceState, msg: Msg<"workflow:created">): Result {
	insertOrUpdateWorkflow(state, msg.workflow);
	return {
		state,
		change: { notify: true, affectsCardOrder: true },
		stateChange: { scope: { entity: "workflow", id: msg.workflow.id }, action: "added" },
	};
}

function handleState(state: WorkflowSliceState, msg: Msg<"workflow:state">): Result {
	if (!msg.workflow) return noNotify(state);
	const prevArchived = state.workflows.get(msg.workflow.id)?.state.archived ?? false;
	insertOrUpdateWorkflow(state, msg.workflow);
	const archivedFlipped = prevArchived !== msg.workflow.archived;
	const affectsCardOrder = archivedFlipped || !!msg.workflow.epicId;
	return {
		state,
		change: { notify: true, affectsCardOrder },
		stateChange: { scope: { entity: "workflow", id: msg.workflow.id }, action: "updated" },
	};
}

function handleRemoved(state: WorkflowSliceState, msg: Msg<"workflow:removed">): Result {
	const id = msg.workflowId;
	if (!state.workflows.has(id)) return unknownId(state, "workflow:removed", id);
	state.workflows.delete(id);
	// If the removed workflow was the currently expanded / selected one, drift back.
	if (state.expandedId === id) state.expandedId = null;
	if (state.selectedChildId === id) state.selectedChildId = null;
	if (state.selectedStepWorkflowId === id) {
		state.selectedStepIndex = null;
		state.selectedStepWorkflowId = null;
	}
	return {
		state,
		change: { notify: true, affectsCardOrder: true },
		stateChange: { scope: { entity: "workflow", id }, action: "removed" },
	};
}

function handleStepChange(state: WorkflowSliceState, msg: Msg<"workflow:step-change">): Result {
	const entry = state.workflows.get(msg.workflowId);
	if (!entry) return unknownId(state, "workflow:step-change", msg.workflowId);
	entry.state.currentStepIndex = msg.currentStepIndex;
	entry.state.reviewCycle.iteration = msg.reviewIteration;
	entry.outputLines = [{ kind: "text", text: `── Step: ${msg.currentStep} ──`, type: "system" }];
	return {
		state,
		change: { notify: true, affectsCardOrder: false },
		stateChange: { scope: { entity: "workflow", id: msg.workflowId }, action: "updated" },
	};
}

// User-action mutators -----------------------------------------------------

const GLOBAL_NOTIFY: Result["change"] = { notify: true, affectsCardOrder: false };
const GLOBAL_UPDATE = { scope: { entity: "global" } as const, action: "updated" as const };

export function selectChild(state: WorkflowSliceState, workflowId: string): Result {
	state.selectedChildId = state.selectedChildId === workflowId ? null : workflowId;
	state.selectedStepIndex = null;
	state.selectedStepWorkflowId = null;
	return { state, change: GLOBAL_NOTIFY, stateChange: GLOBAL_UPDATE };
}

export function selectStep(state: WorkflowSliceState, index: number): Result {
	state.selectedStepIndex = index;
	return { state, change: GLOBAL_NOTIFY, stateChange: GLOBAL_UPDATE };
}

export function selectStepFor(
	state: WorkflowSliceState,
	workflowId: string,
	index: number,
): Result {
	state.selectedStepIndex = index;
	state.selectedStepWorkflowId = workflowId;
	return { state, change: GLOBAL_NOTIFY, stateChange: GLOBAL_UPDATE };
}

export function resetStepSelection(state: WorkflowSliceState): Result {
	state.selectedStepIndex = null;
	state.selectedStepWorkflowId = null;
	return { state, change: GLOBAL_NOTIFY, stateChange: GLOBAL_UPDATE };
}

export function setExpanded(state: WorkflowSliceState, id: string | null): Result {
	state.expandedId = id;
	return { state, change: GLOBAL_NOTIFY, stateChange: GLOBAL_UPDATE };
}

export function addOrUpdateWorkflow(state: WorkflowSliceState, wf: WorkflowState): Result {
	const isNew = !state.workflows.has(wf.id);
	insertOrUpdateWorkflow(state, wf);
	return {
		state,
		change: { notify: true, affectsCardOrder: isNew && !wf.epicId },
		stateChange: { scope: { entity: "workflow", id: wf.id }, action: isNew ? "added" : "updated" },
	};
}

export function reset(state: WorkflowSliceState): Result {
	state.workflows.clear();
	state.selectedChildId = null;
	state.selectedStepIndex = null;
	state.selectedStepWorkflowId = null;
	state.expandedId = null;
	return {
		state,
		change: { notify: true, affectsCardOrder: true },
		stateChange: { scope: { entity: "global" }, action: "cleared" },
	};
}

// Internals ----------------------------------------------------------------

function insertOrUpdateWorkflow(state: WorkflowSliceState, wf: WorkflowState): void {
	const existing = state.workflows.get(wf.id);
	if (existing) {
		existing.state = wf;
		return;
	}
	const currentStep = wf.steps[wf.currentStepIndex];
	const seed = currentStep?.outputLog ? [...currentStep.outputLog] : [];
	state.workflows.set(wf.id, { state: wf, outputLines: seed });
	trimOutput(seed, state.maxOutputLines);
}

function trimOutput(lines: OutputEntry[], maxOutputLines: number): void {
	if (lines.length > maxOutputLines) lines.splice(0, lines.length - maxOutputLines);
}
