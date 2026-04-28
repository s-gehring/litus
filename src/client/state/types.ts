import type {
	Alert,
	EpicAggregatedState,
	EpicClientState,
	StateChange,
	WorkflowClientState,
} from "../../types";

export interface SliceChange {
	notify: boolean;
	affectsCardOrder: boolean;
}

export interface ReducerResult<S> {
	state: S;
	change: SliceChange;
	stateChange: StateChange;
	warnings?: string[];
}

export interface WorkflowSliceState {
	workflows: Map<string, WorkflowClientState>;
	selectedChildId: string | null;
	selectedStepIndex: number | null;
	selectedStepWorkflowId: string | null;
	expandedId: string | null;
	maxOutputLines: number;
}

export interface EpicSliceState {
	epics: Map<string, EpicClientState>;
	epicAggregates: Map<string, EpicAggregatedState>;
	expandedEpicId: string | null;
	maxOutputLines: number;
}

export interface AlertSliceState {
	alerts: Map<string, Alert>;
}

export const DEFAULT_MAX_OUTPUT_LINES = 5000;
