/**
 * Show/hide helpers for the epic feedback form. Operates against the
 * `#epic-feedback-panel` host in `index.html`, mirroring `feedback-panel.ts`
 * for the spec workflow.
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
	errorEl.textContent = "";
	errorEl.classList.add("hidden");

	function updateSubmitDisabled(): void {
		const trimmedLength = input.value.trim().length;
		const overLimit = trimmedLength > MAX_LENGTH;
		submitBtn.disabled = trimmedLength === 0 || overLimit;
	}
	updateSubmitDisabled();

	const submitHandler = () => {
		if (submitBtn.disabled) return;
		const text = input.value.trim();
		if (text.length === 0 || text.length > MAX_LENGTH) return;
		errorEl.textContent = "";
		errorEl.classList.add("hidden");
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
	panel.scrollIntoView({ behavior: "smooth", block: "center" });
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

export function getVisibleEpicFeedbackEpicId(): string | null {
	const panel = document.getElementById("epic-feedback-panel");
	if (!panel || panel.classList.contains("hidden")) return null;
	return panel.dataset.epicId ?? null;
}

export function showEpicFeedbackError(message: string): void {
	const errorEl = document.getElementById("epic-feedback-error");
	if (!errorEl) return;
	errorEl.textContent = message;
	errorEl.classList.remove("hidden");
}
