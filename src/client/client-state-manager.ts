import type {
	Alert,
	EpicAggregatedState,
	EpicClientState,
	OutputEntry,
	ServerMessage,
	StateChange,
	StateChangeListener,
	WorkflowClientState,
	WorkflowState,
} from "../types";
import { EPIC_CARD_PREFIX } from "./components/status-maps";
import { computeEpicAggregatedState } from "./epic-aggregation";

export class ClientStateManager {
	private workflows = new Map<string, WorkflowClientState>();
	private epics = new Map<string, EpicClientState>();
	private alerts = new Map<string, Alert>();
	private epicAggregates = new Map<string, EpicAggregatedState>();
	private cardOrder: string[] = [];
	private expandedId: string | null = null;
	private expandedEpicId: string | null = null;
	private selectedChildId: string | null = null;
	private selectedStepIndex: number | null = null;
	private maxOutputLines = 5000;
	private listener: StateChangeListener | null = null;

	handleMessage(msg: ServerMessage): StateChange {
		const change = this.processMessage(msg);
		if (this.listener) {
			this.listener(change, msg);
		}
		return change;
	}

	onStateChange(cb: StateChangeListener): void {
		this.listener = cb;
	}

	getWorkflows(): ReadonlyMap<string, WorkflowClientState> {
		return this.workflows;
	}

	getEpics(): ReadonlyMap<string, EpicClientState> {
		return this.epics;
	}

	getEpicAggregates(): ReadonlyMap<string, EpicAggregatedState> {
		return this.epicAggregates;
	}

	getAlerts(): ReadonlyMap<string, Alert> {
		return this.alerts;
	}

	getCardOrder(): readonly string[] {
		return this.cardOrder;
	}

	getExpandedId(): string | null {
		return this.expandedId;
	}

	getExpandedEpicId(): string | null {
		return this.expandedEpicId;
	}

	getSelectedChildId(): string | null {
		return this.selectedChildId;
	}

	getSelectedStepIndex(): number | null {
		return this.selectedStepIndex;
	}

	expandItem(id: string): void {
		if (id.startsWith(EPIC_CARD_PREFIX)) {
			const epicId = id.slice(EPIC_CARD_PREFIX.length);
			if (this.expandedEpicId === epicId && !this.selectedChildId) {
				this.expandedEpicId = null;
				this.expandedId = null;
				this.selectedStepIndex = null;
			} else {
				this.expandedEpicId = epicId;
				this.selectedChildId = null;
				this.expandedId = id;
				this.selectedStepIndex = null;
			}
		} else {
			if (this.expandedId === id) {
				this.expandedId = null;
				this.expandedEpicId = null;
				this.selectedChildId = null;
				this.selectedStepIndex = null;
			} else {
				this.expandedId = id;
				this.expandedEpicId = null;
				this.selectedChildId = null;
				this.selectedStepIndex = null;
			}
		}
	}

	selectChild(workflowId: string): void {
		if (this.selectedChildId === workflowId) {
			this.selectedChildId = null;
		} else {
			this.selectedChildId = workflowId;
		}
		this.selectedStepIndex = null;
	}

	selectStep(index: number): void {
		this.selectedStepIndex = index;
	}

	getLastTargetRepo(): string {
		let latest: { repo: string; date: string } | null = null;
		for (const [, entry] of this.workflows) {
			const repo = entry.state.targetRepository;
			if (repo) {
				if (!latest || entry.state.createdAt > latest.date) {
					latest = { repo, date: entry.state.createdAt };
				}
			}
		}
		return latest?.repo ?? "";
	}

	private processMessage(msg: ServerMessage): StateChange {
		switch (msg.type) {
			case "workflow:list":
				return this.handleWorkflowList(msg);
			case "workflow:created":
				return this.handleWorkflowCreated(msg);
			case "workflow:state":
				return this.handleWorkflowState(msg);
			case "workflow:output":
				return this.handleWorkflowOutput(msg);
			case "workflow:tools":
				return this.handleWorkflowTools(msg);
			case "workflow:question":
				return this.handleWorkflowQuestion(msg);
			case "workflow:step-change":
				return this.handleWorkflowStepChange(msg);
			case "epic:list":
				return this.handleEpicList(msg);
			case "epic:created":
				return this.handleEpicCreated(msg);
			case "epic:summary":
				return this.handleEpicSummary(msg);
			case "epic:output":
				return this.handleEpicOutput(msg);
			case "epic:tools":
				return this.handleEpicTools(msg);
			case "epic:result":
				return this.handleEpicResult(msg);
			case "epic:infeasible":
				return this.handleEpicInfeasible(msg);
			case "epic:error":
				return this.handleEpicError(msg);
			case "epic:dependency-update":
				return this.handleEpicDependencyUpdate(msg);
			case "alert:list":
				return this.handleAlertList(msg);
			case "alert:created":
				return this.handleAlertCreated(msg);
			case "alert:dismissed":
				return this.handleAlertDismissed(msg);
			case "purge:progress":
				return { scope: { entity: "none" }, action: "updated" };
			case "purge:complete":
				return this.handlePurgeComplete();
			case "purge:error":
				return { scope: { entity: "none" }, action: "updated" };
			case "config:state":
				return this.handleConfigState(msg);
			case "default-model:info":
				return { scope: { entity: "none" }, action: "updated" };
			case "config:error":
				return { scope: { entity: "config" }, action: "updated" };
			case "log":
				return { scope: { entity: "none" }, action: "updated" };
			case "error":
				return { scope: { entity: "none" }, action: "updated" };
			default:
				return { scope: { entity: "none" }, action: "updated" };
		}
	}

	private handleWorkflowList(msg: Extract<ServerMessage, { type: "workflow:list" }>): StateChange {
		this.workflows.clear();
		for (const wf of msg.workflows) {
			this.addOrUpdateWorkflow(wf);
		}
		this.rebuildEpicAggregates();
		this.rebuildCardOrder();
		return { scope: { entity: "global" }, action: "updated" };
	}

	private handleWorkflowCreated(
		msg: Extract<ServerMessage, { type: "workflow:created" }>,
	): StateChange {
		this.addOrUpdateWorkflow(msg.workflow);
		if (msg.workflow.epicId) {
			this.rebuildEpicAggregates();
			this.rebuildCardOrder();
		} else if (!this.cardOrder.includes(msg.workflow.id)) {
			this.cardOrder.push(msg.workflow.id);
		}
		return { scope: { entity: "workflow", id: msg.workflow.id }, action: "added" };
	}

	private handleWorkflowState(
		msg: Extract<ServerMessage, { type: "workflow:state" }>,
	): StateChange {
		if (!msg.workflow) return { scope: { entity: "none" }, action: "updated" };
		this.addOrUpdateWorkflow(msg.workflow);
		if (msg.workflow.epicId) {
			this.rebuildEpicAggregates();
		}
		return { scope: { entity: "workflow", id: msg.workflow.id }, action: "updated" };
	}

	private handleWorkflowOutput(
		msg: Extract<ServerMessage, { type: "workflow:output" }>,
	): StateChange {
		const entry = this.workflows.get(msg.workflowId);
		if (!entry) return { scope: { entity: "none" }, action: "updated" };
		const outputEntry: OutputEntry = { kind: "text", text: msg.text };
		entry.outputLines.push(outputEntry);
		this.trimOutput(entry.outputLines);
		return { scope: { entity: "output", id: msg.workflowId }, action: "appended" };
	}

	private handleWorkflowTools(
		msg: Extract<ServerMessage, { type: "workflow:tools" }>,
	): StateChange {
		const entry = this.workflows.get(msg.workflowId);
		if (!entry) return { scope: { entity: "none" }, action: "updated" };
		const outputEntry: OutputEntry = { kind: "tools", tools: msg.tools };
		entry.outputLines.push(outputEntry);
		this.trimOutput(entry.outputLines);
		return { scope: { entity: "output", id: msg.workflowId }, action: "appended" };
	}

	private handleWorkflowQuestion(
		msg: Extract<ServerMessage, { type: "workflow:question" }>,
	): StateChange {
		const entry = this.workflows.get(msg.workflowId);
		if (!entry) return { scope: { entity: "none" }, action: "updated" };
		entry.state.pendingQuestion = msg.question;
		return { scope: { entity: "workflow", id: msg.workflowId }, action: "updated" };
	}

	private handleWorkflowStepChange(
		msg: Extract<ServerMessage, { type: "workflow:step-change" }>,
	): StateChange {
		const entry = this.workflows.get(msg.workflowId);
		if (!entry) return { scope: { entity: "none" }, action: "updated" };
		entry.state.currentStepIndex = msg.currentStepIndex;
		entry.state.reviewCycle.iteration = msg.reviewIteration;
		const stepText = `\u2500\u2500 Step: ${msg.currentStep} \u2500\u2500`;
		entry.outputLines = [{ kind: "text", text: stepText, type: "system" }];
		return { scope: { entity: "workflow", id: msg.workflowId }, action: "updated" };
	}

	private handleEpicList(msg: Extract<ServerMessage, { type: "epic:list" }>): StateChange {
		for (const pe of msg.epics) {
			if (!this.epics.has(pe.epicId)) {
				this.epics.set(pe.epicId, { ...pe, outputLines: [] });
				if (pe.workflowIds.length === 0 && !this.cardOrder.includes(pe.epicId)) {
					this.cardOrder.push(pe.epicId);
				}
			}
		}
		this.rebuildEpicAggregates();
		this.rebuildCardOrder();
		return { scope: { entity: "global" }, action: "updated" };
	}

	private handleEpicCreated(msg: Extract<ServerMessage, { type: "epic:created" }>): StateChange {
		this.epics.set(msg.epicId, {
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
		});
		this.cardOrder.push(msg.epicId);
		return { scope: { entity: "epic", id: msg.epicId }, action: "added" };
	}

	private handleEpicSummary(msg: Extract<ServerMessage, { type: "epic:summary" }>): StateChange {
		const epic = this.epics.get(msg.epicId);
		if (!epic) return { scope: { entity: "none" }, action: "updated" };
		epic.title = msg.summary;
		return { scope: { entity: "epic", id: msg.epicId }, action: "updated" };
	}

	private handleEpicOutput(msg: Extract<ServerMessage, { type: "epic:output" }>): StateChange {
		const epic = this.epics.get(msg.epicId);
		if (!epic) return { scope: { entity: "none" }, action: "updated" };
		epic.outputLines.push({ kind: "text", text: msg.text });
		this.trimOutput(epic.outputLines);
		return { scope: { entity: "output", id: msg.epicId }, action: "appended" };
	}

	private handleEpicTools(msg: Extract<ServerMessage, { type: "epic:tools" }>): StateChange {
		const epic = this.epics.get(msg.epicId);
		if (!epic) return { scope: { entity: "none" }, action: "updated" };
		epic.outputLines.push({ kind: "tools", tools: msg.tools });
		this.trimOutput(epic.outputLines);
		return { scope: { entity: "output", id: msg.epicId }, action: "appended" };
	}

	private handleEpicResult(msg: Extract<ServerMessage, { type: "epic:result" }>): StateChange {
		const epic = this.epics.get(msg.epicId);
		if (!epic) return { scope: { entity: "none" }, action: "updated" };
		epic.status = "completed";
		epic.completedAt = new Date().toISOString();
		epic.title = msg.title;
		epic.workflowIds = msg.workflowIds;
		epic.analysisSummary = msg.summary;
		this.rebuildEpicAggregates();
		this.rebuildCardOrder();
		return { scope: { entity: "epic", id: msg.epicId }, action: "updated" };
	}

	private handleEpicInfeasible(
		msg: Extract<ServerMessage, { type: "epic:infeasible" }>,
	): StateChange {
		const epic = this.epics.get(msg.epicId);
		if (!epic) return { scope: { entity: "none" }, action: "updated" };
		epic.status = "infeasible";
		epic.completedAt = new Date().toISOString();
		epic.title = msg.title;
		epic.infeasibleNotes = msg.infeasibleNotes;
		return { scope: { entity: "epic", id: msg.epicId }, action: "updated" };
	}

	private handleEpicError(msg: Extract<ServerMessage, { type: "epic:error" }>): StateChange {
		const epic = this.epics.get(msg.epicId);
		if (!epic) return { scope: { entity: "none" }, action: "updated" };
		epic.status = "error";
		epic.completedAt = new Date().toISOString();
		epic.errorMessage = msg.message;
		epic.outputLines.push({ kind: "text", text: `Error: ${msg.message}`, type: "error" });
		return { scope: { entity: "epic", id: msg.epicId }, action: "updated" };
	}

	private handleEpicDependencyUpdate(
		msg: Extract<ServerMessage, { type: "epic:dependency-update" }>,
	): StateChange {
		const entry = this.workflows.get(msg.workflowId);
		if (!entry) return { scope: { entity: "none" }, action: "updated" };
		entry.state.epicDependencyStatus = msg.epicDependencyStatus;
		return { scope: { entity: "workflow", id: msg.workflowId }, action: "updated" };
	}

	private handleAlertList(msg: Extract<ServerMessage, { type: "alert:list" }>): StateChange {
		this.alerts.clear();
		for (const a of msg.alerts) this.alerts.set(a.id, a);
		return { scope: { entity: "global" }, action: "updated" };
	}

	private handleAlertCreated(msg: Extract<ServerMessage, { type: "alert:created" }>): StateChange {
		this.alerts.set(msg.alert.id, msg.alert);
		return { scope: { entity: "global" }, action: "added" };
	}

	private handleAlertDismissed(
		msg: Extract<ServerMessage, { type: "alert:dismissed" }>,
	): StateChange {
		for (const id of msg.alertIds) this.alerts.delete(id);
		return { scope: { entity: "global" }, action: "removed" };
	}

	private handlePurgeComplete(): StateChange {
		this.workflows.clear();
		this.epics.clear();
		this.epicAggregates.clear();
		this.alerts.clear();
		this.cardOrder.length = 0;
		this.expandedId = null;
		this.expandedEpicId = null;
		this.selectedChildId = null;
		this.selectedStepIndex = null;
		return { scope: { entity: "global" }, action: "cleared" };
	}

	private handleConfigState(msg: Extract<ServerMessage, { type: "config:state" }>): StateChange {
		if (msg.config.timing?.maxClientOutputLines != null) {
			this.maxOutputLines = msg.config.timing.maxClientOutputLines;
		}
		return { scope: { entity: "config" }, action: "updated" };
	}

	private addOrUpdateWorkflow(wfState: WorkflowState): void {
		const existing = this.workflows.get(wfState.id);
		if (existing) {
			existing.state = wfState;
		} else {
			// Seed outputLines from the current step's persisted log so the output
			// window shows full history (text + tool icons) right after page reload,
			// before any incremental workflow:output/workflow:tools events arrive.
			const currentStep = wfState.steps[wfState.currentStepIndex];
			const seed = currentStep?.outputLog ? [...currentStep.outputLog] : [];
			this.workflows.set(wfState.id, {
				state: wfState,
				outputLines: seed,
			});
			this.trimOutput(seed);
			if (!this.cardOrder.includes(wfState.id)) {
				this.cardOrder.push(wfState.id);
			}
		}
	}

	private rebuildEpicAggregates(): void {
		this.epicAggregates.clear();
		const epicGroups = new Map<string, WorkflowState[]>();
		for (const [, entry] of this.workflows) {
			const wf = entry.state;
			if (wf.epicId) {
				if (!epicGroups.has(wf.epicId)) epicGroups.set(wf.epicId, []);
				epicGroups.get(wf.epicId)?.push(wf);
			}
		}
		for (const [epicId, children] of epicGroups) {
			const agg = computeEpicAggregatedState(children);
			if (agg) this.epicAggregates.set(epicId, agg);
		}
	}

	private rebuildCardOrder(): void {
		this.cardOrder.length = 0;
		const seenEpics = new Set<string>();
		const items: { key: string; sortDate: string }[] = [];

		for (const [, entry] of this.workflows) {
			const wf = entry.state;
			if (wf.epicId) {
				if (!seenEpics.has(wf.epicId)) {
					seenEpics.add(wf.epicId);
					const agg = this.epicAggregates.get(wf.epicId);
					items.push({
						key: `${EPIC_CARD_PREFIX}${wf.epicId}`,
						sortDate: agg?.startDate ?? wf.createdAt,
					});
				}
			} else {
				items.push({ key: wf.id, sortDate: wf.createdAt });
			}
		}

		for (const [epicId, epic] of this.epics) {
			if (!seenEpics.has(epicId) && epic.workflowIds.length === 0) {
				items.push({ key: epicId, sortDate: epic.startedAt });
			}
		}

		items.sort((a, b) => a.sortDate.localeCompare(b.sortDate));
		for (const item of items) {
			this.cardOrder.push(item.key);
		}
	}

	private trimOutput(lines: OutputEntry[]): void {
		if (lines.length > this.maxOutputLines) {
			lines.splice(0, lines.length - this.maxOutputLines);
		}
	}
}
