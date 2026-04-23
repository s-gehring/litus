/**
 * Inline panel for submitting epic feedback. Renders a textarea with a live
 * character counter (max 10 000), a submit button disabled on empty or
 * over-limit input, and an inline error region. The textarea value is
 * preserved on rejection.
 */

const MAX_LENGTH = 10_000;

export interface EpicFeedbackPanelHandle {
	element: HTMLDivElement;
	showError(message: string): void;
	clearError(): void;
	getValue(): string;
	focus(): void;
}

export interface EpicFeedbackPanelOptions {
	epicId: string;
	onSubmit: (text: string) => void;
}

export function createEpicFeedbackPanel(opts: EpicFeedbackPanelOptions): EpicFeedbackPanelHandle {
	const panel = document.createElement("div");
	panel.className = "epic-feedback-panel";
	panel.dataset.epicId = opts.epicId;

	const header = document.createElement("div");
	header.className = "epic-feedback-panel-header";
	header.textContent = "Provide feedback on the decomposition";
	panel.appendChild(header);

	const textarea = document.createElement("textarea");
	textarea.className = "epic-feedback-input";
	textarea.rows = 4;
	textarea.placeholder = "Describe what should change about the decomposition…";
	textarea.maxLength = MAX_LENGTH + 1;
	panel.appendChild(textarea);

	const meta = document.createElement("div");
	meta.className = "epic-feedback-meta";

	const counter = document.createElement("span");
	counter.className = "epic-feedback-counter";
	counter.textContent = `0 / ${MAX_LENGTH}`;
	meta.appendChild(counter);

	const errorEl = document.createElement("span");
	errorEl.className = "epic-feedback-error hidden";
	meta.appendChild(errorEl);

	panel.appendChild(meta);

	const actions = document.createElement("div");
	actions.className = "epic-feedback-actions";
	const submitBtn = document.createElement("button");
	submitBtn.type = "button";
	submitBtn.className = "btn btn-primary";
	submitBtn.textContent = "Submit feedback";
	submitBtn.disabled = true;
	actions.appendChild(submitBtn);
	panel.appendChild(actions);

	function updateState(): void {
		const trimmedLength = textarea.value.trim().length;
		const rawLength = textarea.value.length;
		counter.textContent = `${rawLength} / ${MAX_LENGTH}`;
		const overLimit = trimmedLength > MAX_LENGTH;
		counter.classList.toggle("over-limit", overLimit);
		submitBtn.disabled = trimmedLength === 0 || overLimit;
	}

	textarea.addEventListener("input", () => {
		updateState();
	});

	submitBtn.addEventListener("click", () => {
		const trimmed = textarea.value.trim();
		if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) return;
		errorEl.classList.add("hidden");
		errorEl.textContent = "";
		opts.onSubmit(trimmed);
	});

	return {
		element: panel,
		showError(message: string): void {
			errorEl.textContent = message;
			errorEl.classList.remove("hidden");
		},
		clearError(): void {
			errorEl.textContent = "";
			errorEl.classList.add("hidden");
		},
		getValue(): string {
			return textarea.value;
		},
		focus(): void {
			textarea.focus();
		},
	};
}
