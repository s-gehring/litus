import type { EpicAggregatedState, EpicClientState, WorkflowClientState } from "../../../types";
import type { TaskType } from "../../design-system/tokens";
import { EPIC_CARD_PREFIX } from "../status-maps";
import type { TaskState } from "./run-screen-model";
import { taskStateFromStatus } from "./run-screen-model";

export interface TaskPipelineSegment {
	name: string;
	state: "done" | "running" | "queued" | "skip";
}

export interface TaskCardModel {
	id: string;
	routeId: string;
	type: TaskType;
	title: string;
	state: TaskState;
	pipeline: TaskPipelineSegment[];
	currentStep: string | null;
	elapsedMs: number;
	branchProgress: { done: number; total: number } | null;
	selected: boolean;
}

function workflowPipeline(wf: WorkflowClientState): TaskPipelineSegment[] {
	return wf.state.steps.map((s) => ({
		name: s.displayName,
		state:
			s.status === "completed"
				? "done"
				: s.status === "running"
					? "running"
					: ("queued" as TaskPipelineSegment["state"]),
	}));
}

function workflowElapsed(wf: WorkflowClientState): number {
	const started = new Date(wf.state.createdAt).getTime();
	if (!Number.isFinite(started)) return 0;
	return Math.max(0, Date.now() - started);
}

function workflowCard(wf: WorkflowClientState, activeRouteId: string | null): TaskCardModel {
	const type: TaskType = wf.state.workflowKind === "quick-fix" ? "quickfix" : "spec";
	return {
		id: wf.state.id,
		routeId: wf.state.id,
		type,
		title: wf.state.summary || wf.state.specification.slice(0, 80) || wf.state.id,
		state: taskStateFromStatus(wf.state.status),
		pipeline: workflowPipeline(wf),
		currentStep: wf.state.steps[wf.state.currentStepIndex]?.displayName ?? null,
		elapsedMs: workflowElapsed(wf),
		branchProgress: null,
		selected: activeRouteId === wf.state.id,
	};
}

function epicAggregateCard(agg: EpicAggregatedState, activeRouteId: string | null): TaskCardModel {
	const cardId = `${EPIC_CARD_PREFIX}${agg.epicId}`;
	const done = agg.progress.completed;
	const total = agg.progress.total;
	return {
		id: cardId,
		routeId: agg.epicId,
		type: "epic",
		title: agg.title,
		state:
			agg.status === "running"
				? "running"
				: agg.status === "completed"
					? "done"
					: agg.status === "paused"
						? "paused"
						: agg.status === "error"
							? "error"
							: "queued",
		pipeline: [],
		currentStep: null,
		elapsedMs: 0,
		branchProgress: { done, total },
		selected: activeRouteId === agg.epicId,
	};
}

function epicAnalysisCard(epic: EpicClientState, activeRouteId: string | null): TaskCardModel {
	return {
		id: epic.epicId,
		routeId: epic.epicId,
		type: "epic",
		title: (epic.title ?? epic.description).slice(0, 80) || epic.epicId,
		state: "running",
		pipeline: [],
		currentStep: "Analyzing",
		elapsedMs: 0,
		branchProgress: null,
		selected: activeRouteId === epic.epicId,
	};
}

export function projectTaskCards(
	cardOrder: readonly string[],
	workflows: ReadonlyMap<string, WorkflowClientState>,
	epics: ReadonlyMap<string, EpicClientState>,
	epicAggregates: ReadonlyMap<string, EpicAggregatedState>,
	activeRouteId: string | null,
): TaskCardModel[] {
	const out: TaskCardModel[] = [];
	for (const id of cardOrder) {
		if (id.startsWith(EPIC_CARD_PREFIX)) {
			const epicId = id.slice(EPIC_CARD_PREFIX.length);
			const agg = epicAggregates.get(epicId);
			if (agg) {
				out.push(epicAggregateCard(agg, activeRouteId));
				continue;
			}
		}
		const epic = epics.get(id);
		if (epic) {
			out.push(epicAnalysisCard(epic, activeRouteId));
			continue;
		}
		const wf = workflows.get(id);
		if (wf) out.push(workflowCard(wf, activeRouteId));
	}
	return out;
}
