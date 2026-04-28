import type { ServerMessage, StateChange, StateChangeListener } from "../protocol";
import type {
	Alert,
	ClientMessage,
	EpicAggregatedState,
	EpicClientState,
	WorkflowClientState,
	WorkflowState,
} from "../types";
import { EPIC_CARD_PREFIX } from "./components/status-maps";
import * as alertReducer from "./state/alert-state";
import { rebuildCardOrder } from "./state/card-order";
import * as epicReducer from "./state/epic-state";
import type { ReducerResult, SliceChange } from "./state/types";
import * as workflowReducer from "./state/workflow-state";

type SliceSource = "workflow" | "epic" | "alert";
type Dispatched = {
	stateChange: StateChange;
	change: SliceChange;
	warnings?: string[];
	source: SliceSource | null;
};

const NOTIFY_NO_REORDER: SliceChange = { notify: true, affectsCardOrder: false };
const NO_NOTIFY: SliceChange = { notify: false, affectsCardOrder: false };
const NONE_UPDATED = (): Dispatched => ({
	stateChange: { scope: { entity: "none" }, action: "updated" },
	change: NOTIFY_NO_REORDER,
	source: null,
});
const NONE_NOOP = (): Dispatched => ({
	stateChange: { scope: { entity: "none" }, action: "updated" },
	change: NO_NOTIFY,
	source: null,
});

export class ClientStateManager {
	private workflowState = workflowReducer.createState();
	private epicState = epicReducer.createState();
	private alertState = alertReducer.createState();
	private cardOrder: string[] = [];
	private listener: StateChangeListener | null = null;
	private sendToServer: (msg: ClientMessage) => void;

	constructor(sendToServer: (msg: ClientMessage) => void = () => {}) {
		this.sendToServer = sendToServer;
	}

	handleMessage(msg: ServerMessage): StateChange {
		const result = this.dispatch(msg);
		this.applyResult(result, msg);
		return result.stateChange;
	}

	onStateChange(cb: StateChangeListener): void {
		this.listener = cb;
	}

	getWorkflows(): ReadonlyMap<string, WorkflowClientState> {
		return this.workflowState.workflows;
	}
	getEpics(): ReadonlyMap<string, EpicClientState> {
		return this.epicState.epics;
	}
	getEpicAggregates(): ReadonlyMap<string, EpicAggregatedState> {
		return this.epicState.epicAggregates;
	}
	getAlerts(): ReadonlyMap<string, Alert> {
		return this.alertState.alerts;
	}
	getCardOrder(): readonly string[] {
		return this.cardOrder;
	}
	getExpandedId(): string | null {
		return this.workflowState.expandedId;
	}
	getExpandedEpicId(): string | null {
		return this.epicState.expandedEpicId;
	}
	getSelectedChildId(): string | null {
		return this.workflowState.selectedChildId;
	}
	getSelectedStepIndex(): number | null {
		return this.workflowState.selectedStepIndex;
	}
	getSelectedStepIndexFor(workflowId: string): number | null {
		return this.workflowState.selectedStepWorkflowId === workflowId
			? this.workflowState.selectedStepIndex
			: null;
	}

	getLastTargetRepo(): string {
		let latest: { repo: string; date: string } | null = null;
		for (const [, entry] of this.workflowState.workflows) {
			const repo = entry.state.targetRepository;
			if (repo && (!latest || entry.state.createdAt > latest.date)) {
				latest = { repo, date: entry.state.createdAt };
			}
		}
		return latest?.repo ?? "";
	}

	expandItem(id: string): void {
		// Cross-slice: workflow + epic expansion mirror each other in lockstep.
		const ws = this.workflowState;
		const es = this.epicState;
		if (id.startsWith(EPIC_CARD_PREFIX)) {
			const epicId = id.slice(EPIC_CARD_PREFIX.length);
			const close = es.expandedEpicId === epicId && !ws.selectedChildId;
			epicReducer.setExpandedEpic(es, close ? null : epicId);
			workflowReducer.setExpanded(ws, close ? null : id);
		} else {
			const close = ws.expandedId === id;
			workflowReducer.setExpanded(ws, close ? null : id);
			epicReducer.setExpandedEpic(es, null);
		}
		ws.selectedChildId = null;
		workflowReducer.resetStepSelection(ws);
	}

	selectChild(workflowId: string): void {
		workflowReducer.selectChild(this.workflowState, workflowId);
	}
	selectStep(index: number): void {
		workflowReducer.selectStep(this.workflowState, index);
	}
	selectStepFor(workflowId: string, index: number): void {
		workflowReducer.selectStepFor(this.workflowState, workflowId, index);
	}
	resetStepSelection(): void {
		workflowReducer.resetStepSelection(this.workflowState);
	}

	addOrUpdateWorkflow(wfState: WorkflowState): void {
		const result = workflowReducer.addOrUpdateWorkflow(this.workflowState, wfState);
		if (result.change.affectsCardOrder) this.rebuild();
	}

	private dispatch(msg: ServerMessage): Dispatched {
		if (isWorkflowSliceMsg(msg)) {
			return tagged(workflowReducer.reduce(this.workflowState, msg), "workflow");
		}
		if (isEpicSliceMsg(msg)) {
			return tagged(epicReducer.reduce(this.epicState, msg), "epic");
		}
		if (isAlertSliceMsg(msg)) {
			return tagged(alertReducer.reduce(this.alertState, msg), "alert");
		}
		if (msg.type === "purge:complete") {
			workflowReducer.reset(this.workflowState);
			epicReducer.reset(this.epicState);
			alertReducer.reset(this.alertState);
			return {
				stateChange: { scope: { entity: "global" }, action: "cleared" },
				change: { notify: true, affectsCardOrder: true },
				source: null,
			};
		}
		if (msg.type === "config:state") {
			const max = msg.config.timing?.maxClientOutputLines;
			if (max != null) {
				workflowReducer.setMaxOutputLines(this.workflowState, max);
				epicReducer.setMaxOutputLines(this.epicState, max);
			}
			return {
				stateChange: { scope: { entity: "config" }, action: "updated" },
				change: NOTIFY_NO_REORDER,
				source: null,
			};
		}
		if (msg.type === "config:error") {
			return {
				stateChange: { scope: { entity: "config" }, action: "updated" },
				change: NOTIFY_NO_REORDER,
				source: null,
			};
		}
		if (msg.type === "console:output") {
			// Pure side-effect: dev console only. No slice state to mutate.
			console.log(`[litus:console] ${msg.text}`);
			return NONE_NOOP();
		}
		// auto-archive:state, workflow:archive-denied, purge:progress, purge:error,
		// default-model:info, error, repo:clone-* — façade-level no-ops that still
		// notify subscribers (parity with master, scope=none).
		return NONE_UPDATED();
	}

	private applyResult(result: Dispatched, msg: ServerMessage): void {
		if (result.warnings && result.source) {
			for (const w of result.warnings) {
				this.sendToServer({ type: "client:warning", source: result.source, message: w });
			}
		}
		if (result.change.affectsCardOrder) this.rebuild();
		if (result.change.notify && this.listener) this.listener(result.stateChange, msg);
	}

	private rebuild(): void {
		epicReducer.recomputeAggregates(this.epicState, this.workflowState.workflows);
		rebuildCardOrder(this.cardOrder, this.workflowState, this.epicState);
	}
}

function isWorkflowSliceMsg(msg: ServerMessage): msg is workflowReducer.WorkflowSliceMessage {
	return (workflowReducer.OWNED_TYPES as ReadonlySet<string>).has(msg.type);
}

function isEpicSliceMsg(msg: ServerMessage): msg is epicReducer.EpicSliceMessage {
	return (epicReducer.OWNED_TYPES as ReadonlySet<string>).has(msg.type);
}

function isAlertSliceMsg(msg: ServerMessage): msg is alertReducer.AlertSliceMessage {
	return (alertReducer.OWNED_TYPES as ReadonlySet<string>).has(msg.type);
}

function tagged<S>(result: ReducerResult<S>, source: SliceSource): Dispatched {
	return {
		stateChange: result.stateChange,
		change: result.change,
		warnings: result.warnings,
		source,
	};
}
