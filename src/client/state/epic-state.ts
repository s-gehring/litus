import type {
	EpicAggregatedState,
	EpicClientState,
	OutputEntry,
	ServerMessage,
	WorkflowClientState,
	WorkflowState,
} from "../../types";
import { computeEpicAggregatedState } from "../epic-aggregation";
import { DEFAULT_MAX_OUTPUT_LINES, type EpicSliceState, type ReducerResult } from "./types";

const EPIC_OWNED = [
	"epic:list",
	"epic:created",
	"epic:summary",
	"epic:output",
	"epic:tools",
	"epic:result",
	"epic:infeasible",
	"epic:error",
	"epic:feedback:accepted",
	"epic:feedback:rejected",
	"epic:feedback:history",
	"epic:start-first-level:result",
] as const;

export type EpicOwnedType = (typeof EPIC_OWNED)[number];
export const OWNED_TYPES: ReadonlySet<EpicOwnedType> = new Set(EPIC_OWNED);
export type EpicSliceMessage = Extract<ServerMessage, { type: EpicOwnedType }>;

type Result = ReducerResult<EpicSliceState>;
type Msg<T extends EpicOwnedType> = Extract<EpicSliceMessage, { type: T }>;

export function createState(maxOutputLines: number = DEFAULT_MAX_OUTPUT_LINES): EpicSliceState {
	return {
		epics: new Map<string, EpicClientState>(),
		epicAggregates: new Map<string, EpicAggregatedState>(),
		expandedEpicId: null,
		maxOutputLines,
	};
}

export function setMaxOutputLines(state: EpicSliceState, max: number): EpicSliceState {
	state.maxOutputLines = max;
	return state;
}

export function reduce(state: EpicSliceState, message: EpicSliceMessage): Result {
	switch (message.type) {
		case "epic:list":
			return handleList(state, message);
		case "epic:created":
			return handleCreated(state, message);
		case "epic:summary":
			return mutateEpic(state, message.epicId, "epic:summary", false, (e) => {
				e.title = message.summary;
			});
		case "epic:output":
			return appendOutput(state, message.epicId, { kind: "text", text: message.text }, "output");
		case "epic:tools":
			return appendOutput(state, message.epicId, { kind: "tools", tools: message.tools }, "tools");
		case "epic:result":
			return mutateEpic(state, message.epicId, "epic:result", true, (e) => {
				e.status = "completed";
				e.completedAt = new Date().toISOString();
				e.title = message.title;
				e.workflowIds = message.workflowIds;
				e.analysisSummary = message.summary;
			});
		case "epic:infeasible":
			return mutateEpic(state, message.epicId, "epic:infeasible", false, (e) => {
				e.status = "infeasible";
				e.completedAt = new Date().toISOString();
				e.title = message.title;
				e.infeasibleNotes = message.infeasibleNotes;
			});
		case "epic:error":
			return mutateEpic(state, message.epicId, "epic:error", false, (e) => {
				e.status = "error";
				e.completedAt = new Date().toISOString();
				e.errorMessage = message.message;
				e.outputLines.push({ kind: "text", text: `Error: ${message.message}`, type: "error" });
			});
		case "epic:feedback:accepted":
			return handleFeedbackAccepted(state, message);
		case "epic:feedback:rejected":
		case "epic:start-first-level:result":
			return scopeOnly(state, message.epicId, false);
		case "epic:feedback:history":
			return mutateEpic(state, message.epicId, "epic:feedback:history", false, (e) => {
				e.feedbackHistory = message.entries;
				e.sessionContextLost = message.sessionContextLost;
			});
	}
}

// Reducer helpers ----------------------------------------------------------

function unknownId(state: EpicSliceState, msgType: string, id: string): Result {
	return {
		state,
		change: { notify: false, affectsCardOrder: false },
		stateChange: { scope: { entity: "none" }, action: "updated" },
		warnings: [`${msgType} for unknown epicId '${id}'`],
	};
}

function scopeOnly(state: EpicSliceState, epicId: string, affectsCardOrder: boolean): Result {
	return {
		state,
		change: { notify: true, affectsCardOrder },
		stateChange: { scope: { entity: "epic", id: epicId }, action: "updated" },
	};
}

function mutateEpic(
	state: EpicSliceState,
	epicId: string,
	msgType: string,
	affectsCardOrder: boolean,
	mutate: (epic: EpicClientState) => void,
): Result {
	const epic = state.epics.get(epicId);
	if (!epic) return unknownId(state, msgType, epicId);
	mutate(epic);
	return scopeOnly(state, epicId, affectsCardOrder);
}

function appendOutput(
	state: EpicSliceState,
	epicId: string,
	out: OutputEntry,
	msgType: "output" | "tools",
): Result {
	const epic = state.epics.get(epicId);
	if (!epic) return unknownId(state, `epic:${msgType}`, epicId);
	epic.outputLines.push(out);
	trimOutput(epic.outputLines, state.maxOutputLines);
	return {
		state,
		change: { notify: true, affectsCardOrder: false },
		stateChange: { scope: { entity: "output", id: epicId }, action: "appended" },
	};
}

// Per-message handlers -----------------------------------------------------

function handleList(state: EpicSliceState, msg: Msg<"epic:list">): Result {
	for (const pe of msg.epics) {
		const existing = state.epics.get(pe.epicId);
		if (!existing) {
			state.epics.set(pe.epicId, { ...pe, outputLines: [] });
		} else {
			Object.assign(existing, {
				archived: pe.archived,
				archivedAt: pe.archivedAt,
				workflowIds: pe.workflowIds,
				title: pe.title,
				status: pe.status,
				completedAt: pe.completedAt,
				errorMessage: pe.errorMessage,
				infeasibleNotes: pe.infeasibleNotes,
				analysisSummary: pe.analysisSummary,
			});
		}
	}
	return {
		state,
		change: { notify: true, affectsCardOrder: true },
		stateChange: { scope: { entity: "global" }, action: "updated" },
	};
}

function handleCreated(state: EpicSliceState, msg: Msg<"epic:created">): Result {
	state.epics.set(msg.epicId, {
		epicId: msg.epicId,
		description: msg.description,
		status: "analyzing",
		title: null,
		outputLines: [],
		workflowIds: [],
		startedAt: new Date().toISOString(),
		completedAt: null,
		errorMessage: null,
		infeasibleNotes: null,
		analysisSummary: null,
		decompositionSessionId: null,
		feedbackHistory: [],
		sessionContextLost: false,
		attemptCount: 1,
		archived: false,
		archivedAt: null,
	});
	return {
		state,
		change: { notify: true, affectsCardOrder: true },
		stateChange: { scope: { entity: "epic", id: msg.epicId }, action: "added" },
	};
}

function handleFeedbackAccepted(state: EpicSliceState, msg: Msg<"epic:feedback:accepted">): Result {
	const epic = state.epics.get(msg.epicId);
	if (!epic) return unknownId(state, "epic:feedback:accepted", msg.epicId);
	if (!epic.feedbackHistory.some((e) => e.id === msg.entry.id)) {
		epic.feedbackHistory = [...epic.feedbackHistory, msg.entry];
	}
	epic.attemptCount = Math.max(epic.attemptCount, epic.feedbackHistory.length + 1);
	epic.status = "analyzing";
	// Reset the timer so idle time between the prior completion and this
	// feedback submission isn't billed to the new analysis attempt.
	epic.startedAt = new Date().toISOString();
	epic.completedAt = null;
	// Prior child workflows are being deleted server-side; clear the
	// reference list so aggregate recomputation doesn't hold on to them.
	epic.workflowIds = [];
	return scopeOnly(state, msg.epicId, true);
}

// User-action mutators -----------------------------------------------------

export function setExpandedEpic(state: EpicSliceState, epicId: string | null): Result {
	state.expandedEpicId = epicId;
	return {
		state,
		change: { notify: true, affectsCardOrder: false },
		stateChange: { scope: { entity: "global" }, action: "updated" },
	};
}

// Cross-slice helper invoked by the façade after a workflow change with
// affectsCardOrder=true. Mutates state.epicAggregates in place.
export function recomputeAggregates(
	state: EpicSliceState,
	workflows: ReadonlyMap<string, WorkflowClientState>,
): EpicSliceState {
	state.epicAggregates.clear();
	const groups = new Map<string, WorkflowState[]>();
	for (const [, entry] of workflows) {
		const wf = entry.state;
		if (!wf.epicId) continue;
		let bucket = groups.get(wf.epicId);
		if (!bucket) {
			bucket = [];
			groups.set(wf.epicId, bucket);
		}
		bucket.push(wf);
	}
	for (const [epicId, children] of groups) {
		const agg = computeEpicAggregatedState(children);
		if (agg) state.epicAggregates.set(epicId, agg);
	}
	if (state.expandedEpicId && !state.epics.has(state.expandedEpicId)) {
		state.expandedEpicId = null;
	}
	return state;
}

export function reset(state: EpicSliceState): Result {
	state.epics.clear();
	state.epicAggregates.clear();
	state.expandedEpicId = null;
	return {
		state,
		change: { notify: true, affectsCardOrder: true },
		stateChange: { scope: { entity: "global" }, action: "cleared" },
	};
}

function trimOutput(lines: OutputEntry[], maxOutputLines: number): void {
	if (lines.length > maxOutputLines) lines.splice(0, lines.length - maxOutputLines);
}
