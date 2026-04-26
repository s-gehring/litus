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
import { type ActionSpec, renderDetailActions } from "./detail-actions";
import { hideDetailLayout, showDetailLayout } from "./detail-layout";
import {
	hideFeedbackPanel,
	hideFeedbackPanelUnlessFor,
	isFeedbackPanelVisible,
	renderFeedbackHistory,
} from "./feedback-panel";
import { hideNotFoundPanel, showNotFoundPanel } from "./not-found-panel";
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
	updateFeedbackHistorySection,
	updateFlavor,
	updateSpecDetails,
	updateStepSummary,
	updateSummary,
	updateUserInput,
	updateWorkflowErrorBanner,
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
	/**
	 * Optional bridge so out-of-band re-renders of the pipeline-steps strip
	 * (today: the async `fetchWorkflowArtifacts` resolution in app.ts) can
	 * dispatch step clicks back into this handler's `doSelectStep` instead of
	 * relying on a no-op click handler. Called with the handler's internal
	 * selector on mount, and with `null` on unmount.
	 */
	setSelectStep?: (selectStep: ((index: number) => void) | null) => void;
}

export function createWorkflowDetailHandler(deps: WorkflowDetailDeps): RouteHandler {
	let currentWorkflowId: string | null = null;

	function renderFull(): void {
		if (!currentWorkflowId) return;
		const entry = deps.getState().getWorkflows().get(currentWorkflowId);
		if (!entry) {
			showNotFoundPanel("workflow", currentWorkflowId);
			return;
		}
		if (entry.state.archived) {
			const summary = entry.state.summary || entry.state.specification;
			hideNotFoundPanel();
			deps.navigate("/archive");
			import("./alert-toast").then(({ showAlertToast }) => {
				showAlertToast({
					id: `archive-redirect-${entry.state.id}-${Date.now()}`,
					type: "workflow-finished",
					title: "Workflow is archived",
					description: summary,
					workflowId: entry.state.id,
					epicId: entry.state.epicId,
					targetRoute: "/archive",
					createdAt: Date.now(),
					seen: true,
				});
			});
			return;
		}
		hideNotFoundPanel();
		renderDetail(entry);
	}

	function renderDetail(entry: WorkflowClientState): void {
		const wf = entry.state;
		const state = deps.getState();
		const selectedStepIndex = state.getSelectedStepIndex();

		updateWorkflowStatus(wf);
		updateWorkflowErrorBanner(wf);
		updateBranchInfo(wf);
		updateActiveModelPanel({ kind: "workflow", workflow: wf });
		renderPipelineSteps(wf, selectedStepIndex, doSelectStep, deps.getArtifactContext(wf.id));
		if (!deps.getArtifactContext(wf.id)) {
			deps.fetchArtifacts(wf.id);
		}
		// Always update — when summary is empty (e.g. summarizer agent errored) fall
		// back to the raw specification so the title doesn't keep showing the previous
		// detail's text. Matches the card's `wf.summary || wf.specification` fallback.
		updateSummary(wf.summary || wf.specification);
		updateStepSummary(wf.stepSummary ?? "");
		updateFlavor(wf.flavor ?? "");
		updateUserInput(wf.specification);
		updateSpecDetails("");
		updateFeedbackHistorySection(wf.feedbackEntries);

		const actions = buildActionButtons(wf);
		renderDetailActions(actions);

		renderBackToEpicButton(wf);

		autoSelectStep(wf);

		const isTerminal =
			wf.status === "aborted" || wf.status === "completed" || wf.status === "error";
		if (wf.pendingQuestion && !isTerminal) {
			showQuestion(wf.pendingQuestion);
		} else {
			hideQuestion();
		}

		const currentStepName = wf.steps[wf.currentStepIndex]?.name;
		const feedbackEligible =
			(wf.status === "paused" &&
				deps.getAutoMode() === "manual" &&
				currentStepName === STEP.MERGE_PR) ||
			// FR-016: errored fix-implement accepts appended retry context.
			(wf.status === "error" && currentStepName === STEP.FIX_IMPLEMENT);
		if (!feedbackEligible) {
			hideFeedbackPanel();
		} else if (isFeedbackPanelVisible()) {
			renderFeedbackHistory(wf.feedbackEntries);
		}

		hideFeedbackPanelUnlessFor(wf.id);
	}

	function buildActionButtons(wf: WorkflowState): ActionSpec[] {
		const actions: ActionSpec[] = [];
		const autoMode = deps.getAutoMode();
		const currentStepName = wf.steps[wf.currentStepIndex]?.name;

		if (wf.status === "running") {
			actions.push({
				key: "pause",
				onClick: () => deps.send({ type: "workflow:pause", workflowId: wf.id }),
			});
		}
		if (wf.status === "paused") {
			actions.push({
				key: "resume",
				onClick: () => deps.send({ type: "workflow:resume", workflowId: wf.id }),
			});
			if (autoMode === "manual" && currentStepName === STEP.MERGE_PR) {
				actions.push({ key: "provide-feedback", onClick: () => deps.openFeedbackPanel(wf) });
			}
			actions.push({
				key: "abort",
				onClick: () => deps.send({ type: "workflow:abort", workflowId: wf.id }),
			});
		}
		if (wf.status === "waiting_for_input" || wf.status === "waiting_for_dependencies") {
			actions.push({
				key: "abort",
				onClick: () => deps.send({ type: "workflow:abort", workflowId: wf.id }),
			});
		}
		if (wf.status === "error") {
			actions.push({
				key: "retry-step",
				onClick: () => deps.send({ type: "workflow:retry", workflowId: wf.id }),
			});
			// FR-016: an errored fix-implement step accepts appended feedback as
			// retry context — expose the same feedback panel used for manual-mode
			// merge-pr pauses. `handleFeedback` enforces the status/step invariant
			// server-side; this button is the only UI entry point.
			if (currentStepName === STEP.FIX_IMPLEMENT) {
				actions.push({ key: "provide-feedback", onClick: () => deps.openFeedbackPanel(wf) });
			}
			// Abort is offered alongside Retry so the user can put an unrecoverable
			// workflow into a terminal state. Without it, a stuck error holds its
			// managed-repo refcount indefinitely (error is non-terminal for refcount).
			actions.push({
				key: "abort",
				onClick: () => deps.send({ type: "workflow:abort", workflowId: wf.id }),
			});
		}
		// Reset and retry — available from `error` OR `aborted`. Resets the entire
		// workflow to Setup, deleting branch/worktree/artifacts. Distinct from
		// the per-step `retry-step` action above.
		if (wf.status === "error" || wf.status === "aborted") {
			actions.push({
				key: "retry-workflow",
				onClick: () => deps.send({ type: "workflow:retry-workflow", workflowId: wf.id }),
			});
		}
		if (wf.status === "idle" && wf.epicId) {
			actions.push({
				key: "start",
				onClick: () => deps.send({ type: "workflow:start-existing", workflowId: wf.id }),
			});
		}
		if (wf.status === "waiting_for_dependencies") {
			actions.push({
				key: "force-start",
				onClick: () => deps.send({ type: "workflow:force-start", workflowId: wf.id }),
			});
		}
		// Archive — hidden for child specs (FR-008), disabled while running (FR-003).
		if (wf.epicId === null) {
			const running = wf.status === "running";
			const isTerminal =
				wf.status === "completed" || wf.status === "aborted" || wf.status === "error";
			actions.push({
				key: "archive",
				onClick: () => deps.send({ type: "workflow:archive", workflowId: wf.id }),
				disabled: running ? { reason: "Cannot archive while running" } : undefined,
				// Terminal workflows skip confirmation; non-terminal show a warning copy.
				confirmOverride: isTerminal
					? null
					: {
							title: "Archive this workflow?",
							body: "This workflow has not finished. Archiving it will hide it from the active workspace. You can unarchive it later from the Archive page.",
							confirmLabel: "Archive",
							cancelLabel: "Cancel",
						},
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

	/**
	 * Pick the step to display. Respects any valid selection the user has
	 * already made for this workflow (including the one `mount()` restores from
	 * `ClientStateManager.getSelectedStepIndexFor`); otherwise falls back to
	 * the live step for in-progress workflows or the last non-pending step for
	 * terminal ones.
	 */
	function autoSelectStep(wf: WorkflowState): void {
		if (currentWorkflowId) {
			const existing = deps.getState().getSelectedStepIndexFor(currentWorkflowId);
			if (existing != null && existing >= 0 && existing < wf.steps.length) {
				doSelectStep(existing);
				return;
			}
		}
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
		// Gate on activeInvocation so the spinner only shows when a model is
		// actually at work. Non-AI steps (SETUP / MERGE_PR / SYNC_REPO) run
		// without an invocation, and there are brief windows between steps
		// where activeInvocation is cleared — the spinner must not contradict
		// the "No model in use" panel in either case.
		syncThinkingIndicator(
			idx === wf.currentStepIndex &&
				wf.status === "running" &&
				step?.status === "running" &&
				wf.activeInvocation !== null,
		);
	}

	function hideLayout(): void {
		const existingBreadcrumb = document.getElementById("epic-breadcrumb");
		if (existingBreadcrumb) existingBreadcrumb.remove();
		hideNotFoundPanel();
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
			deps.setSelectStep?.(doSelectStep);
			renderFull();
		},
		unmount() {
			currentWorkflowId = null;
			deps.setSelectStep?.(null);
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
