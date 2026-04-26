import { computeEligibleFirstLevelSpecs } from "../../epic-eligibility";
import type {
	AppConfig,
	ClientMessage,
	EpicAggregatedState,
	EpicClientState,
	ServerMessage,
	WorkflowState,
} from "../../types";
import type { ClientStateManager } from "../client-state-manager";
import { $ } from "../dom";
import { renderMarkdown } from "../render-markdown";
import type { RouteHandler, RouteMatch } from "../router";
import { showConfirmModal } from "./confirm-modal";
import { hideDetailLayout, showDetailLayout } from "./detail-layout";
import { renderEpicTree, updateEpicTreeRow } from "./epic-tree";
import { hideNotFoundPanel, showNotFoundPanel } from "./not-found-panel";
import { renderPipelineSteps } from "./pipeline-steps";
import { EPIC_AGG_STATUS_CLASSES } from "./status-maps";
import {
	appendOutput,
	appendToolIcons,
	clearOutput,
	renderOutputEntries,
	updateActiveModelPanel,
	updateBranchInfo,
	updateDetailActions,
	updateEpicStatus,
	updateFeedbackHistorySection,
	updateFlavor,
	updateSpecDetails,
	updateStepSummary,
	updateSummary,
	updateUserInput,
} from "./workflow-window";

export interface EpicDetailDeps {
	getState: () => ClientStateManager;
	getConfig: () => AppConfig | null;
	send: (msg: ClientMessage) => void;
	navigate: (path: string) => void;
}

export function createEpicDetailHandler(deps: EpicDetailDeps): RouteHandler {
	let currentEpicId: string | null = null;
	const startFirstLevelInFlight = new Set<string>();

	function hideLayout(): void {
		const existingAnalysis = document.getElementById("epic-analysis-notes");
		if (existingAnalysis) existingAnalysis.remove();
		hideNotFoundPanel();
		hideDetailLayout();
	}

	function renderAnalysisView(epic: EpicClientState): void {
		updateEpicStatus(epic.status);
		updateActiveModelPanelForEpic(epic);
		renderPipelineSteps(null);
		updateSummary(epic.title || epic.description);
		updateStepSummary("");
		updateFlavor("");
		updateUserInput(epic.description);
		updateSpecDetails("");
		updateDetailActions([]);
		updateBranchInfo(null);
		updateFeedbackHistorySection([]);

		const stepLabel = document.getElementById("current-step-label");
		if (stepLabel) stepLabel.classList.add("hidden");

		const outputAreaEl = $("#output-area");
		outputAreaEl.classList.add("epic-tree-fullsize");

		clearOutput();
		if (epic.status === "infeasible" && epic.infeasibleNotes) {
			const outputLog = $("#output-log");
			const notesEl = document.createElement("div");
			notesEl.className = "user-input epic-analysis-notes infeasible-notes-fullheight";
			notesEl.innerHTML = renderMarkdown(epic.infeasibleNotes);
			outputLog.appendChild(notesEl);
		} else if (epic.outputLines.length > 0) {
			renderOutputEntries(epic.outputLines);
		}
	}

	function renderTreeView(agg: EpicAggregatedState): void {
		const state = deps.getState();
		const epics = state.getEpics();
		const workflows = state.getWorkflows();

		const statusBadge = $("#workflow-status");
		statusBadge.textContent = agg.status;
		statusBadge.className = `status-badge ${EPIC_AGG_STATUS_CLASSES[agg.status] || "card-status-idle"}`;

		updateBranchInfo(null);
		const epicData = epics.get(agg.epicId);
		if (epicData) {
			updateActiveModelPanelForEpic(epicData);
		} else {
			updateActiveModelPanel({ kind: "hidden" });
		}
		renderPipelineSteps(null);
		updateSummary(`${agg.title} (${agg.progress.completed}/${agg.progress.total} completed)`);
		updateStepSummary("");
		const stepLabel = document.getElementById("current-step-label");
		if (stepLabel) stepLabel.classList.add("hidden");
		updateFlavor("");
		const actionChildren: WorkflowState[] = [];
		for (const id of agg.childWorkflowIds) {
			const entry = workflows.get(id);
			if (entry) actionChildren.push(entry.state);
		}
		updateDetailActions(buildEpicActions(agg.epicId, epicData ?? null, actionChildren));
		clearOutput();
		updateSpecDetails("");
		updateFeedbackHistorySection([]);

		if (epicData) {
			updateUserInput(epicData.description);
			renderEpicAnalysisNotes(epicData);
		} else {
			updateUserInput("");
		}

		const outputAreaEl = $("#output-area");
		outputAreaEl.classList.add("epic-tree-fullsize");

		const childWorkflows = new Map<string, WorkflowState>();
		for (const id of agg.childWorkflowIds) {
			const entry = workflows.get(id);
			if (entry) childWorkflows.set(id, entry.state);
		}

		const outputLog = $("#output-log");
		outputLog.replaceChildren();

		const tree = renderEpicTree(agg, childWorkflows, (workflowId) => {
			deps.navigate(`/workflow/${workflowId}`);
		});
		outputLog.appendChild(tree);
	}

	function renderEpicAnalysisNotes(epicData: EpicClientState): void {
		const existing = document.getElementById("epic-analysis-notes");
		if (existing) existing.remove();

		const content = epicData.analysisSummary || epicData.infeasibleNotes;
		if (!content) return;

		const container = document.createElement("div");
		container.id = "epic-analysis-notes";
		container.className = "epic-analysis-notes user-input";
		container.innerHTML = renderMarkdown(content);

		const userInput = document.getElementById("user-input");
		if (userInput) {
			userInput.parentElement?.insertBefore(container, userInput.nextSibling);
		}
	}

	function buildEpicActions(
		epicId: string,
		epic: EpicClientState | null,
		children: WorkflowState[],
	): { label: string; className: string; onClick: () => void }[] {
		const actions: { label: string; className: string; onClick: () => void }[] = [];
		const anyRunning = children.some((c) => c.status === "running");
		const nonTerminal = children.some(
			(c) => !(c.status === "completed" || c.status === "aborted" || c.status === "error"),
		);
		if (epic?.archived) {
			actions.push({
				label: "View in archive",
				className: "btn-secondary",
				onClick: () => deps.navigate("/archive"),
			});
			return actions;
		}

		const eligible = computeEligibleFirstLevelSpecs(epicId, children);
		if (eligible.length > 0) {
			const inFlight = startFirstLevelInFlight.has(epicId);
			actions.push({
				label: inFlight
					? "Starting…"
					: `Start ${eligible.length} ${eligible.length === 1 ? "spec" : "specs"}`,
				className: inFlight ? "btn-primary btn-disabled btn-loading" : "btn-primary",
				onClick: () => {
					if (startFirstLevelInFlight.has(epicId)) return;
					startFirstLevelInFlight.add(epicId);
					deps.send({ type: "epic:start-first-level", epicId });
					renderFull();
				},
			});
		}

		actions.push({
			label: anyRunning ? "Archive (disabled while running)" : "Archive",
			className: anyRunning ? "btn-secondary btn-disabled" : "btn-secondary",
			onClick: async () => {
				if (anyRunning) return;
				if (nonTerminal) {
					const unfinished = children.filter(
						(c) => !(c.status === "completed" || c.status === "aborted" || c.status === "error"),
					).length;
					const ok = await showConfirmModal({
						title: "Archive this epic?",
						body: `${unfinished} workflow${unfinished === 1 ? " has" : "s have"} not finished. Archiving the epic will archive all of its workflows — you can unarchive later.`,
						confirmLabel: "Archive",
						cancelLabel: "Cancel",
					});
					if (!ok) return;
				}
				deps.send({ type: "epic:archive", epicId });
			},
		});
		return actions;
	}

	function updateActiveModelPanelForEpic(epic: EpicClientState): void {
		const config = deps.getConfig();
		if (epic.status !== "analyzing" || !config) {
			updateActiveModelPanel({ kind: "hidden" });
			return;
		}
		updateActiveModelPanel({
			kind: "epic-analysis",
			model: config.models.epicDecomposition,
			effort: config.efforts.epicDecomposition,
		});
	}

	function renderFull(): void {
		if (!currentEpicId) return;
		const state = deps.getState();
		const archivedEpic = state.getEpics().get(currentEpicId);
		if (archivedEpic?.archived) {
			const epicSummary = archivedEpic.title ?? archivedEpic.description;
			const epicIdSnapshot = archivedEpic.epicId;
			hideNotFoundPanel();
			deps.navigate("/archive");
			import("./alert-toast").then(({ showAlertToast }) => {
				showAlertToast({
					id: `archive-redirect-epic-${epicIdSnapshot}-${Date.now()}`,
					type: "epic-finished",
					title: "Epic is archived",
					description: epicSummary,
					workflowId: null,
					epicId: epicIdSnapshot,
					targetRoute: "/archive",
					createdAt: Date.now(),
					seen: true,
				});
			});
			return;
		}
		const agg = state.getEpicAggregates().get(currentEpicId);
		if (agg) {
			hideNotFoundPanel();
			renderTreeView(agg);
			return;
		}
		const epic = state.getEpics().get(currentEpicId);
		if (epic) {
			hideNotFoundPanel();
			renderAnalysisView(epic);
			return;
		}
		showNotFoundPanel("epic", currentEpicId);
	}

	return {
		mount(_container: HTMLElement, match: RouteMatch) {
			currentEpicId = match.params.id ?? null;
			showDetailLayout();
			renderFull();
		},
		unmount() {
			currentEpicId = null;
			hideLayout();
		},
		onMessage(msg: ServerMessage) {
			if (!currentEpicId) return;
			switch (msg.type) {
				case "epic:summary":
				case "epic:result":
				case "epic:infeasible": {
					if (msg.epicId === currentEpicId) renderFull();
					break;
				}
				case "epic:output": {
					if (msg.epicId === currentEpicId) appendOutput(msg.text);
					break;
				}
				case "epic:tools": {
					if (msg.epicId === currentEpicId) appendToolIcons(msg.tools);
					break;
				}
				case "epic:error": {
					if (msg.epicId === currentEpicId) {
						appendOutput(`Error: ${msg.message}`, "error");
					}
					break;
				}
				case "epic:start-first-level:result": {
					// The :result envelope is the only canonical signal that clears
					// the in-flight flag. Generic `error` messages are intentionally
					// ignored here: they have no request-id correlation, so an
					// unrelated failure (e.g. from a side-panel handler) could
					// otherwise prematurely re-enable the button or — if the user
					// has navigated away — leave the flag stuck for the old epic.
					if (startFirstLevelInFlight.delete(msg.epicId) && msg.epicId === currentEpicId) {
						renderFull();
					}
					break;
				}
				case "epic:dependency-update": {
					// Re-render tree if a child of our epic got an update.
					const state = deps.getState();
					const entry = state.getWorkflows().get(msg.workflowId);
					if (entry?.state.epicId === currentEpicId) renderFull();
					break;
				}
				case "workflow:state": {
					// A child workflow state changed. Try a surgical in-place row
					// update first — that avoids redrawing every sibling on every
					// streaming broadcast — and fall back to a full re-render only
					// when the target node is not already in the DOM (e.g. the
					// workflow just joined the epic).
					if (msg.workflow?.epicId !== currentEpicId) break;
					const treeContainer = document.querySelector<HTMLElement>(".epic-tree-container");
					if (treeContainer && updateEpicTreeRow(treeContainer, msg.workflow.id, msg.workflow)) {
						// Surgical row update skips the full re-render, so refresh
						// the aggregate summary + status badge so the counter
						// ("N/M completed") tracks completions in real time.
						const agg = deps.getState().getEpicAggregates().get(currentEpicId);
						if (agg) {
							updateSummary(
								`${agg.title} (${agg.progress.completed}/${agg.progress.total} completed)`,
							);
							const statusBadge = $("#workflow-status");
							statusBadge.textContent = agg.status;
							statusBadge.className = `status-badge ${EPIC_AGG_STATUS_CLASSES[agg.status] || "card-status-idle"}`;
						}
						break;
					}
					renderFull();
					break;
				}
				case "workflow:list":
				case "epic:list": {
					renderFull();
					break;
				}
				case "workflow:created": {
					// Only re-render if the new workflow belongs to our epic.
					if (msg.workflow.epicId === currentEpicId) renderFull();
					break;
				}
				case "epic:created": {
					// A new epic never affects the currently viewed epic.
					break;
				}
			}
		},
	};
}
