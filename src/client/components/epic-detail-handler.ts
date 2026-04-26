import { computeEligibleFirstLevelSpecs } from "../../epic-eligibility";
import type {
	AppConfig,
	ClientMessage,
	EpicAggregatedState,
	EpicClientState,
	EpicFeedbackEntry,
	ServerMessage,
	WorkflowState,
} from "../../types";
import { isFeedbackEligible } from "../../types";
import type { ClientStateManager } from "../client-state-manager";
import { $ } from "../dom";
import { renderMarkdown } from "../render-markdown";
import type { RouteHandler, RouteMatch } from "../router";
import { showConfirmModal } from "./confirm-modal";
import { hideDetailLayout, showDetailLayout } from "./detail-layout";
import {
	hideEpicFeedbackPanel,
	hideEpicFeedbackPanelUnlessFor,
	isEpicFeedbackPanelVisible,
	showEpicFeedbackError,
	showEpicFeedbackPanel,
} from "./epic-feedback-panel";
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
	// Preserve the user's in-progress textarea across re-renders. Unrelated
	// server broadcasts (workflow:state, epic:feedback:history, etc.) trigger
	// renderFull() which rebuilds the feedback panel; without this the
	// textarea would reset to empty mid-typing. FR-014 requires the text to
	// survive a rejection and its spirit extends to transient re-renders.
	// Keyed by epicId so switching epics doesn't leak state.
	const feedbackDrafts = new Map<string, string>();
	const startFirstLevelInFlight = new Set<string>();

	function hideLayout(): void {
		const existingAnalysis = document.getElementById("epic-analysis-notes");
		if (existingAnalysis) existingAnalysis.remove();
		removeEpicFeedbackUi();
		hideNotFoundPanel();
		hideDetailLayout();
	}

	function removeEpicFeedbackUi(): void {
		const existing = document.getElementById("epic-feedback-ui");
		if (existing) existing.remove();
	}

	function openEpicFeedbackForm(epicId: string): void {
		showEpicFeedbackPanel({
			epicId,
			initialText: feedbackDrafts.get(epicId) ?? "",
			onChange: (text) => {
				if (text.length === 0) feedbackDrafts.delete(epicId);
				else feedbackDrafts.set(epicId, text);
			},
			onSubmit: (text) => {
				// Keep the draft until the server confirms acceptance — see
				// the epic:feedback:accepted handler. Rejection preserves the
				// textarea per FR-014.
				feedbackDrafts.set(epicId, text);
				deps.send({ type: "epic:feedback", epicId, text });
			},
			onCancel: () => {
				feedbackDrafts.delete(epicId);
				hideEpicFeedbackPanel();
				renderFull();
			},
		});
		// Re-render so detail-actions hides the "Provide Feedback" button.
		renderFull();
	}

	function renderEpicFeedbackHistorySection(epic: EpicClientState): void {
		const section = document.getElementById("epic-feedback-section");
		if (!section) return;
		section.replaceChildren();
		if (epic.feedbackHistory.length === 0) {
			section.classList.add("hidden");
			return;
		}
		section.classList.remove("hidden");
		for (const entry of epic.feedbackHistory) {
			section.appendChild(renderEpicFeedbackEntry(entry));
		}
	}

	function renderEpicFeedbackUi(epic: EpicClientState): void {
		removeEpicFeedbackUi();
		const showableStatuses: Array<EpicClientState["status"]> = ["completed", "infeasible", "error"];
		if (!showableStatuses.includes(epic.status)) {
			renderEpicFeedbackHistorySection(epic);
			return;
		}

		// Context-lost notice — dismissable. Sits next to the history block in
		// the description column rather than the bottom of the screen.
		if (epic.sessionContextLost) {
			const container = document.createElement("div");
			container.id = "epic-feedback-ui";
			container.className = "epic-feedback-ui";

			const notice = document.createElement("div");
			notice.className = "epic-feedback-context-lost";
			const text = document.createElement("span");
			text.textContent = "Prior agent context was lost. A fresh decomposition was produced.";
			notice.appendChild(text);
			const dismissBtn = document.createElement("button");
			dismissBtn.type = "button";
			dismissBtn.className = "btn btn-secondary";
			dismissBtn.textContent = "Dismiss";
			dismissBtn.addEventListener("click", () => {
				deps.send({
					type: "epic:feedback:ack-context-lost",
					epicId: epic.epicId,
				});
			});
			notice.appendChild(dismissBtn);
			container.appendChild(notice);

			const userInput = document.getElementById("user-input");
			userInput?.parentElement?.insertBefore(container, userInput.nextSibling);
		}

		renderEpicFeedbackHistorySection(epic);
	}

	function renderEpicFeedbackEntry(entry: EpicFeedbackEntry): HTMLDivElement {
		const row = document.createElement("div");
		row.className = "feedback-entry epic-feedback-entry";

		const header = document.createElement("div");
		header.className = "feedback-entry-header";

		const ts = document.createElement("span");
		ts.className = "feedback-entry-timestamp";
		ts.textContent = new Date(entry.submittedAt).toLocaleString();
		ts.title = entry.submittedAt;
		header.appendChild(ts);

		const badge = document.createElement("span");
		const outcomeValue = entry.outcome ?? "pending";
		const outcomeClass =
			outcomeValue === "completed"
				? "outcome-success"
				: outcomeValue === "infeasible"
					? "outcome-no-changes"
					: outcomeValue === "error"
						? "outcome-failed"
						: "outcome-pending";
		badge.className = `feedback-entry-outcome ${outcomeClass}`;
		badge.textContent = outcomeValue;
		header.appendChild(badge);

		if (entry.contextLostOnThisAttempt) {
			const flag = document.createElement("span");
			flag.className = "feedback-entry-context-lost";
			flag.textContent = "context lost";
			header.appendChild(flag);
		}

		row.appendChild(header);

		const text = document.createElement("div");
		text.className = "feedback-entry-text";
		text.textContent = entry.text;
		row.appendChild(text);

		return row;
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

		renderEpicFeedbackUi(epic);
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

		if (epicData) {
			renderEpicFeedbackUi(epicData);
		}
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

		// Provide Feedback button. Hidden while the form is open (mutual
		// exclusion invariant 1) and while feedback is in-flight or otherwise
		// ineligible. The form is the global #epic-feedback-panel host.
		if (epic && isFeedbackEligible(epic, children) && !isEpicFeedbackPanelVisible()) {
			actions.push({
				label: "Provide Feedback",
				className: "btn-secondary",
				onClick: () => openEpicFeedbackForm(epicId),
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
			const previousEpicId = currentEpicId;
			currentEpicId = match.params.id ?? null;
			// Switching epics with the form open: discard the prior epic's
			// draft and close the form unless we're remounting the same epic
			// (FR-013, spec Q4).
			if (previousEpicId && previousEpicId !== currentEpicId) {
				feedbackDrafts.delete(previousEpicId);
			}
			hideEpicFeedbackPanelUnlessFor(currentEpicId);
			showDetailLayout();
			renderFull();
		},
		unmount() {
			if (currentEpicId) feedbackDrafts.delete(currentEpicId);
			hideEpicFeedbackPanel();
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
				case "workflow:removed": {
					// A prior child of the currently viewed epic was deleted (e.g.
					// feedback accepted). Re-render so the stale row disappears from
					// the tree.
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
				case "epic:feedback:accepted": {
					if (msg.epicId === currentEpicId) {
						feedbackDrafts.delete(msg.epicId);
						hideEpicFeedbackPanel();
						renderFull();
					}
					break;
				}
				case "epic:feedback:rejected": {
					if (msg.epicId === currentEpicId) {
						showEpicFeedbackError(msg.reason);
					}
					break;
				}
				case "epic:feedback:history": {
					if (msg.epicId === currentEpicId) renderFull();
					break;
				}
			}
		},
	};
}
