import type {
	AutoMode,
	ClientMessage,
	ServerMessage,
	WorkflowClientState,
	WorkflowState,
} from "../../types";
import { STEP } from "../../types";
import type { ClientStateManager } from "../client-state-manager";
import type { RouteHandler, RouteMatch } from "../router";
import { BACK_TO_EPIC_PREFIX, backToEpicLabel } from "./back-to-epic-label";
import { hideDetailLayout, showDetailLayout } from "./detail-layout";
import {
	hideFeedbackPanel,
	hideFeedbackPanelUnlessFor,
	isFeedbackPanelVisible,
	renderFeedbackHistory,
} from "./feedback-panel";
import type { PipelineStepsArtifactContext } from "./pipeline-steps";
import { renderPipelineSteps } from "./pipeline-steps";
import { hideQuestion, showQuestion } from "./question-panel";
import {
	appendOutput,
	appendToolIcons,
	clearOutput,
	removeThinkingIndicator,
	renderOutputEntries,
	syncThinkingIndicator,
	updateActiveModelPanel,
	updateBranchInfo,
	updateDetailActions,
	updateFeedbackHistorySection,
	updateFlavor,
	updateSpecDetails,
	updateStepSummary,
	updateSummary,
	updateUserInput,
	updateWorkflowStatus,
} from "./workflow-window";

export interface WorkflowDetailDeps {
	getState: () => ClientStateManager;
	getAutoMode: () => AutoMode;
	getArtifactContext: (workflowId: string) => PipelineStepsArtifactContext | null;
	fetchArtifacts: (workflowId: string) => void;
	send: (msg: ClientMessage) => void;
	navigate: (path: string) => void;
	openFeedbackPanel: (wf: WorkflowState) => void;
}

export function createWorkflowDetailHandler(deps: WorkflowDetailDeps): RouteHandler {
	let currentWorkflowId: string | null = null;

	function renderFull(): void {
		if (!currentWorkflowId) return;
		const entry = deps.getState().getWorkflows().get(currentWorkflowId);
		if (!entry) {
			clearOutput();
			appendOutput("This workflow no longer exists", "system");
			return;
		}
		renderDetail(entry);
	}

	function renderDetail(entry: WorkflowClientState): void {
		const wf = entry.state;
		const state = deps.getState();
		const selectedStepIndex = state.getSelectedStepIndex();

		updateWorkflowStatus(wf);
		updateBranchInfo(wf);
		updateActiveModelPanel({ kind: "workflow", workflow: wf });
		renderPipelineSteps(wf, selectedStepIndex, doSelectStep, deps.getArtifactContext(wf.id));
		if (!deps.getArtifactContext(wf.id)) {
			deps.fetchArtifacts(wf.id);
		}
		if (wf.summary) updateSummary(wf.summary);
		updateStepSummary(wf.stepSummary ?? "");
		updateFlavor(wf.flavor ?? "");
		updateUserInput(wf.specification);
		updateSpecDetails("");
		updateFeedbackHistorySection(wf.feedbackEntries);

		const actions = buildActionButtons(wf);
		updateDetailActions(actions);

		renderBackToEpicButton(wf);

		autoSelectStep(wf);

		const isTerminal =
			wf.status === "cancelled" || wf.status === "completed" || wf.status === "error";
		if (wf.pendingQuestion && !isTerminal) {
			showQuestion(wf.pendingQuestion);
		} else {
			hideQuestion();
		}

		const feedbackEligible =
			wf.status === "paused" &&
			deps.getAutoMode() === "manual" &&
			wf.steps[wf.currentStepIndex]?.name === STEP.MERGE_PR;
		if (!feedbackEligible) {
			hideFeedbackPanel();
		} else if (isFeedbackPanelVisible()) {
			renderFeedbackHistory(wf.feedbackEntries);
		}

		hideFeedbackPanelUnlessFor(wf.id);
	}

	function buildActionButtons(
		wf: WorkflowState,
	): { label: string; className: string; onClick: () => void }[] {
		const actions: { label: string; className: string; onClick: () => void }[] = [];
		const isError = wf.status === "error";
		const autoMode = deps.getAutoMode();

		if (wf.status === "running") {
			actions.push({
				label: "Pause",
				className: "btn-secondary",
				onClick: () => deps.send({ type: "workflow:pause", workflowId: wf.id }),
			});
		}
		if (wf.status === "paused") {
			actions.push({
				label: "Resume",
				className: "btn-primary",
				onClick: () => deps.send({ type: "workflow:resume", workflowId: wf.id }),
			});
			if (autoMode === "manual" && wf.steps[wf.currentStepIndex]?.name === STEP.MERGE_PR) {
				actions.push({
					label: "Provide Feedback",
					className: "btn-secondary",
					onClick: () => deps.openFeedbackPanel(wf),
				});
			}
			actions.push({
				label: "Abort",
				className: "btn-danger",
				onClick: () => {
					if (confirm("Are you sure you want to abort this workflow?")) {
						deps.send({ type: "workflow:abort", workflowId: wf.id });
					}
				},
			});
		}
		if (wf.status === "waiting_for_input" || wf.status === "waiting_for_dependencies") {
			actions.push({
				label: "Abort",
				className: "btn-danger",
				onClick: () => {
					if (confirm("Are you sure you want to abort this workflow?")) {
						deps.send({ type: "workflow:abort", workflowId: wf.id });
					}
				},
			});
		}
		if (isError) {
			actions.push({
				label: "Retry",
				className: "btn-secondary",
				onClick: () => deps.send({ type: "workflow:retry", workflowId: wf.id }),
			});
		}
		if (wf.status === "idle" && wf.epicId) {
			actions.push({
				label: "Start",
				className: "btn-primary",
				onClick: () => deps.send({ type: "workflow:start-existing", workflowId: wf.id }),
			});
		}
		if (wf.status === "waiting_for_dependencies") {
			actions.push({
				label: "Force Start",
				className: "btn-secondary",
				onClick: () => deps.send({ type: "workflow:force-start", workflowId: wf.id }),
			});
		}
		return actions;
	}

	let lastBackButtonEpicId: string | null = null;

	function renderBackToEpicButton(wf: WorkflowState): void {
		const existing = document.getElementById("epic-breadcrumb");

		if (!wf.epicId) {
			if (existing) existing.remove();
			lastBackButtonEpicId = null;
			return;
		}

		const title = backToEpicLabel(wf.epicId, deps.getState());

		// Fast path: same epic, button already present — only refresh the title.
		if (existing && lastBackButtonEpicId === wf.epicId) {
			const titleSpan = existing.querySelector<HTMLElement>(".epic-title");
			if (titleSpan && titleSpan.textContent !== title) titleSpan.textContent = title;
			return;
		}

		if (existing) existing.remove();

		const userInput = document.getElementById("user-input");
		if (!userInput) return;

		const btn = document.createElement("button");
		btn.className = "back-to-epic";
		btn.id = "epic-breadcrumb";
		btn.type = "button";

		const prefix = document.createElement("span");
		prefix.className = "back-to-epic-prefix";
		prefix.textContent = BACK_TO_EPIC_PREFIX;
		btn.appendChild(prefix);

		const titleSpan = document.createElement("span");
		titleSpan.className = "epic-title";
		titleSpan.textContent = title;
		btn.appendChild(titleSpan);

		const epicId = wf.epicId;
		btn.addEventListener("click", () => {
			deps.navigate(`/epic/${epicId}`);
		});
		userInput.parentElement?.insertBefore(btn, userInput);
		lastBackButtonEpicId = epicId;
	}

	function autoSelectStep(wf: WorkflowState): void {
		if (wf.status === "running" || wf.status === "waiting_for_input" || wf.status === "paused") {
			doSelectStep(wf.currentStepIndex);
		} else if (wf.steps.length > 0) {
			let lastActive = 0;
			for (let i = wf.steps.length - 1; i >= 0; i--) {
				if (wf.steps[i].status !== "pending") {
					lastActive = i;
					break;
				}
			}
			doSelectStep(lastActive);
		}
	}

	function doSelectStep(index: number): void {
		if (!currentWorkflowId) return;
		const state = deps.getState();
		state.selectStepFor(currentWorkflowId, index);

		const entry = state.getWorkflows().get(currentWorkflowId);
		if (!entry) return;

		const wf = entry.state;
		const step = wf.steps[index];
		if (!step) return;

		clearOutput();

		for (const run of step.history) {
			const startedAt = new Date(run.startedAt);
			const formattedStart = Number.isNaN(startedAt.getTime())
				? run.startedAt
				: startedAt.toLocaleString();
			appendOutput(`── Run ${run.runNumber} · ${formattedStart} · ${run.status} ──`, "system");
			if (run.outputLog && run.outputLog.length > 0) {
				renderOutputEntries(run.outputLog);
			} else if (run.output) {
				appendOutput(run.output);
			}
			if (run.error) appendOutput(`Error: ${run.error}`, "error");
		}

		const isCurrentStep = index === wf.currentStepIndex;
		const isLive = isCurrentStep && (wf.status === "running" || wf.status === "waiting_for_input");

		if (isCurrentStep && entry.outputLines.length > 0) {
			renderOutputEntries(entry.outputLines);
			if (!isLive && step.error) appendOutput(`Error: ${step.error}`, "error");
		} else if (step.outputLog && step.outputLog.length > 0) {
			renderOutputEntries(step.outputLog);
			if (!isLive && step.error) appendOutput(`Error: ${step.error}`, "error");
		} else if (step.output || step.error) {
			if (step.output) appendOutput(step.output);
			if (step.error) appendOutput(`Error: ${step.error}`, "error");
		} else if (!isLive && step.history.length === 0) {
			appendOutput("No output yet", "system");
		}

		renderPipelineSteps(
			wf,
			state.getSelectedStepIndex(),
			doSelectStep,
			deps.getArtifactContext(wf.id),
		);

		syncThinkingIndicatorForStep(wf, index);
	}

	function syncThinkingIndicatorForStep(wf: WorkflowState, idx: number): void {
		const step = wf.steps[idx];
		syncThinkingIndicator(
			idx === wf.currentStepIndex && wf.status === "running" && step?.status === "running",
		);
	}

	function hideLayout(): void {
		const existingBreadcrumb = document.getElementById("epic-breadcrumb");
		if (existingBreadcrumb) existingBreadcrumb.remove();
		hideDetailLayout();
	}

	return {
		mount(_container: HTMLElement, match: RouteMatch) {
			currentWorkflowId = match.params.id ?? null;
			showDetailLayout();
			const state = deps.getState();
			const wf = state.getWorkflows().get(currentWorkflowId ?? "")?.state;
			// Re-entry step selection:
			//  1. If the user previously viewed *this same* workflow and picked a
			//     step, restore it (as long as the step still exists).
			//  2. Otherwise — first visit, or coming from a different workflow —
			//     land on the live step, not step 0.
			const previousIndex = currentWorkflowId
				? state.getSelectedStepIndexFor(currentWorkflowId)
				: null;
			const inRange =
				previousIndex != null && wf && previousIndex >= 0 && previousIndex < wf.steps.length;
			const targetIndex = inRange ? (previousIndex as number) : (wf?.currentStepIndex ?? 0);
			if (currentWorkflowId) state.selectStepFor(currentWorkflowId, targetIndex);
			renderFull();
		},
		unmount() {
			currentWorkflowId = null;
			hideLayout();
		},
		onMessage(msg: ServerMessage) {
			if (!currentWorkflowId) return;
			switch (msg.type) {
				case "workflow:list": {
					// Reconcile: if our workflow is no longer present, show a placeholder.
					renderFull();
					break;
				}
				case "workflow:state": {
					if (msg.workflow?.id === currentWorkflowId) {
						renderFull();
					}
					break;
				}
				case "workflow:output": {
					if (msg.workflowId !== currentWorkflowId) break;
					const state = deps.getState();
					const entry = state.getWorkflows().get(currentWorkflowId);
					if (!entry) break;
					if (state.getSelectedStepIndex() === entry.state.currentStepIndex) {
						appendOutput(msg.text);
					}
					break;
				}
				case "workflow:tools": {
					if (msg.workflowId !== currentWorkflowId) break;
					const state = deps.getState();
					const entry = state.getWorkflows().get(currentWorkflowId);
					if (!entry) break;
					if (state.getSelectedStepIndex() === entry.state.currentStepIndex) {
						appendToolIcons(msg.tools);
					}
					break;
				}
				case "workflow:question": {
					if (msg.workflowId !== currentWorkflowId) break;
					showQuestion(msg.question);
					break;
				}
				case "workflow:step-change": {
					if (msg.workflowId !== currentWorkflowId) break;
					removeThinkingIndicator();
					const state = deps.getState();
					const entry = state.getWorkflows().get(currentWorkflowId);
					if (entry) {
						state.selectStepFor(currentWorkflowId, msg.currentStepIndex);
						renderFull();
					}
					deps.fetchArtifacts(currentWorkflowId);
					break;
				}
			}
		},
	};
}
