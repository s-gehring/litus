import { STEP } from "../../pipeline-steps";
import type { WorkflowState } from "../../types";
import { renderMarkdown } from "../render-markdown";

const PANEL_ID = "ask-answer-panel";

interface AskAnswerPanelHandlers {
	onRetryAspect?: (workflowId: string) => void;
}

/**
 * Render the synthesized answer for an ask-question workflow (and an error
 * banner with a retry control when an aspect failed). Finalize + Provide
 * feedback live in the standard detail-actions bar — this panel is purely the
 * answer / aspect-error surface.
 *
 * Idempotent: re-rendering replaces the previous panel contents in place.
 * When the panel has nothing to render it is hidden so it doesn't claim
 * vertical space.
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

	const hasContent = panel.childElementCount > 0;
	panel.classList.toggle("hidden", !hasContent);

	// When the panel is showing the synthesized answer, the standard output-log
	// has nothing useful to add for the ANSWER / FINALIZE steps and would
	// otherwise render as an empty bordered box that pushes the answer to the
	// bottom of the viewport. Hide it while the answer is on screen.
	const outputArea = parent.querySelector<HTMLElement>("#output-area");
	if (outputArea) {
		const hideOutput = Boolean(workflow.synthesizedAnswer);
		outputArea.classList.toggle("hidden", hideOutput);
	}

	if (!existing) parent.appendChild(panel);
}

export function hideAskAnswerPanel(parent: HTMLElement): void {
	const panel = parent.querySelector<HTMLDivElement>(`#${PANEL_ID}`);
	if (panel) panel.remove();
	const outputArea = parent.querySelector<HTMLElement>("#output-area");
	if (outputArea) outputArea.classList.remove("hidden");
}
