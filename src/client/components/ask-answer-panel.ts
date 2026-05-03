import { STEP } from "../../pipeline-steps";
import type { WorkflowState } from "../../types";
import { renderMarkdown } from "../render-markdown";

const PANEL_ID = "ask-answer-panel";

interface AskAnswerPanelHandlers {
	onFinalize: (workflowId: string) => void;
	onSubmitFeedback: (workflowId: string, text: string) => void;
	onRetryAspect?: (workflowId: string) => void;
}

/**
 * Render the synthesized answer + finalize control + feedback panel for an
 * ask-question workflow. The panel is only mounted when the workflow is paused
 * at the `answer` step, with a separate variant for the `error` state on the
 * `research-aspect` step (offering a retry button).
 *
 * Idempotent: re-rendering replaces the previous panel contents in place.
 */
export function renderAskAnswerPanel(
	parent: HTMLElement,
	workflow: WorkflowState,
	handlers: AskAnswerPanelHandlers,
): void {
	const existing = parent.querySelector<HTMLDivElement>(`#${PANEL_ID}`);
	const panel = existing ?? document.createElement("div");
	panel.id = PANEL_ID;
	panel.className = "ask-answer-panel";
	panel.replaceChildren();

	if (workflow.synthesizedAnswer) {
		const answerEl = document.createElement("div");
		answerEl.className = "ask-answer-content";
		answerEl.innerHTML = renderMarkdown(workflow.synthesizedAnswer.markdown);
		panel.appendChild(answerEl);
	}

	const step = workflow.steps[workflow.currentStepIndex];
	const isPausedAtAnswer = workflow.status === "waiting_for_input" && step?.name === STEP.ANSWER;
	const erroredAspect = workflow.aspects?.find((a) => a.status === "errored") ?? null;

	if (erroredAspect && workflow.status === "error" && step?.name === STEP.RESEARCH_ASPECT) {
		const banner = document.createElement("div");
		banner.className = "ask-aspect-error";
		const msg = document.createElement("p");
		msg.textContent = erroredAspect.errorMessage
			? `Aspect "${erroredAspect.id}" failed: ${erroredAspect.errorMessage}`
			: `Aspect "${erroredAspect.id}" failed.`;
		banner.appendChild(msg);
		if (handlers.onRetryAspect) {
			const retryBtn = document.createElement("button");
			retryBtn.className = "btn btn-secondary";
			retryBtn.textContent = "Retry aspect";
			retryBtn.addEventListener("click", () => handlers.onRetryAspect?.(workflow.id));
			banner.appendChild(retryBtn);
		}
		panel.appendChild(banner);
	}

	if (isPausedAtAnswer) {
		const actions = document.createElement("div");
		actions.className = "ask-answer-actions";

		const feedbackForm = document.createElement("div");
		feedbackForm.className = "ask-answer-feedback";
		const feedbackLabel = document.createElement("label");
		feedbackLabel.textContent = "Refine the answer with feedback";
		const feedbackInput = document.createElement("textarea");
		feedbackInput.rows = 3;
		feedbackInput.placeholder = "What should change about the answer?";
		const feedbackBtn = document.createElement("button");
		feedbackBtn.className = "btn btn-primary";
		feedbackBtn.textContent = "Submit feedback";
		feedbackBtn.disabled = true;
		feedbackInput.addEventListener("input", () => {
			feedbackBtn.disabled = feedbackInput.value.trim() === "";
		});
		feedbackBtn.addEventListener("click", () => {
			const text = feedbackInput.value.trim();
			if (!text) return;
			handlers.onSubmitFeedback(workflow.id, text);
			feedbackInput.value = "";
			feedbackBtn.disabled = true;
		});
		feedbackForm.appendChild(feedbackLabel);
		feedbackForm.appendChild(feedbackInput);
		feedbackForm.appendChild(feedbackBtn);
		actions.appendChild(feedbackForm);

		const finalizeRow = document.createElement("div");
		finalizeRow.className = "ask-answer-finalize";
		const finalizeBtn = document.createElement("button");
		finalizeBtn.className = "btn btn-secondary";
		finalizeBtn.textContent = "Finalize";
		finalizeBtn.addEventListener("click", () => handlers.onFinalize(workflow.id));
		finalizeRow.appendChild(finalizeBtn);
		actions.appendChild(finalizeRow);

		panel.appendChild(actions);
	}

	if (!existing) parent.appendChild(panel);
}

export function hideAskAnswerPanel(parent: HTMLElement): void {
	const panel = parent.querySelector<HTMLDivElement>(`#${PANEL_ID}`);
	if (panel) panel.remove();
}
