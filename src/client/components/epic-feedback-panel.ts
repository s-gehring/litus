/**
 * Show/hide helpers for the epic feedback form. Operates against the
 * `#epic-feedback-panel` host in `index.html`, mirroring `feedback-panel.ts`
 * for the spec workflow.
 *
 * Singleton: one panel exists in the DOM. These helpers therefore mutate
 * shared state and are not reentrant — opening one epic's form implicitly
 * closes any other. Today's UI shows a single epic detail at a time, so
 * this is fine; revisit if multi-detail layouts are introduced.
 */

import { EPIC_FEEDBACK_MAX_LENGTH } from "../../types";
import { $ } from "../dom";

const MAX_LENGTH = EPIC_FEEDBACK_MAX_LENGTH;

export interface ShowEpicFeedbackPanelOptions {
	epicId: string;
	initialText?: string;
	onSubmit: (text: string) => void;
	onCancel: () => void;
	onChange?: (text: string) => void;
}

export function showEpicFeedbackPanel(opts: ShowEpicFeedbackPanelOptions): void {
	const panel = $("#epic-feedback-panel");
	const input = $("#epic-feedback-input") as HTMLTextAreaElement;
	const submitBtn = $("#btn-submit-epic-feedback") as HTMLButtonElement;
	const cancelBtn = $("#btn-cancel-epic-feedback") as HTMLButtonElement;
	const errorEl = $("#epic-feedback-error");

	// `+ 1` lets the textarea briefly hold one character past the cap so the
	// over-limit gating disables the submit button. validateTextInput on the
	// server rejects anything past MAX_LENGTH; a hard maxLength would clamp
	// silently and hide the feedback.
	input.maxLength = MAX_LENGTH + 1;
	input.value = opts.initialText ?? "";

	function updateSubmitDisabled(): void {
		const trimmedLength = input.value.trim().length;
		const overLimit = trimmedLength > MAX_LENGTH;
		submitBtn.disabled = trimmedLength === 0 || overLimit;
		// FR-014: surface the over-limit state inline so a user pasting too
		// much text sees why submit is disabled instead of silent failure.
		if (overLimit) {
			errorEl.textContent = `Too long — ${trimmedLength.toLocaleString()} / ${MAX_LENGTH.toLocaleString()} characters. Please shorten.`;
			errorEl.classList.remove("hidden");
		} else if (errorEl.dataset.source !== "server") {
			errorEl.textContent = "";
			errorEl.classList.add("hidden");
		}
	}
	delete errorEl.dataset.source;
	updateSubmitDisabled();

	const submitHandler = () => {
		if (submitBtn.disabled) return;
		const text = input.value.trim();
		errorEl.textContent = "";
		errorEl.classList.add("hidden");
		delete errorEl.dataset.source;
		opts.onSubmit(text);
	};
	const cancelHandler = () => {
		opts.onCancel();
	};
	const inputHandler = () => {
		updateSubmitDisabled();
		opts.onChange?.(input.value);
	};

	// Replace handlers to avoid duplicate bindings on repeated open.
	submitBtn.onclick = submitHandler;
	cancelBtn.onclick = cancelHandler;
	input.oninput = inputHandler;
	input.onkeydown = (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			submitHandler();
		}
	};

	panel.dataset.epicId = opts.epicId;
	panel.classList.remove("hidden");
	input.focus();
	// FR-005: only scroll if not already visible. Skipping the smooth-scroll
	// when the panel is already on screen avoids a jarring re-center.
	if (!isElementInViewport(panel)) {
		panel.scrollIntoView({ behavior: "smooth", block: "center" });
	}
}

function isElementInViewport(el: HTMLElement): boolean {
	const rect = el.getBoundingClientRect();
	const viewportH = window.innerHeight || document.documentElement.clientHeight;
	const viewportW = window.innerWidth || document.documentElement.clientWidth;
	return rect.bottom > 0 && rect.right > 0 && rect.top < viewportH && rect.left < viewportW;
}

export function hideEpicFeedbackPanel(): void {
	const panel = document.getElementById("epic-feedback-panel");
	if (!panel) return;
	panel.classList.add("hidden");
	delete panel.dataset.epicId;
	const errorEl = document.getElementById("epic-feedback-error");
	if (errorEl) {
		errorEl.textContent = "";
		errorEl.classList.add("hidden");
	}
}

export function hideEpicFeedbackPanelUnlessFor(activeEpicId: string | null): void {
	const panel = document.getElementById("epic-feedback-panel");
	if (!panel || panel.classList.contains("hidden")) return;
	if (activeEpicId !== null && panel.dataset.epicId === activeEpicId) return;
	hideEpicFeedbackPanel();
}

export function isEpicFeedbackPanelVisible(): boolean {
	const panel = document.getElementById("epic-feedback-panel");
	return panel !== null && !panel.classList.contains("hidden");
}

export function showEpicFeedbackError(message: string): void {
	const errorEl = document.getElementById("epic-feedback-error");
	if (!errorEl) return;
	errorEl.textContent = message;
	errorEl.classList.remove("hidden");
	// Mark the source so updateSubmitDisabled does not clobber a server-sent
	// rejection reason while the user edits text below the cap.
	errorEl.dataset.source = "server";
}
