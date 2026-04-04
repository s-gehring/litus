import type { ClientMessage } from "../../types";

export type EpicFormState = "idle" | "analyzing" | "error";

let errorMessage = "";

export function createEpicForm(
	send: (msg: ClientMessage) => void,
	getTargetRepo: () => string,
): HTMLElement {
	const container = document.createElement("div");
	container.id = "epic-form";
	container.className = "epic-form hidden";

	container.innerHTML = `
		<div class="epic-form-header">
			<span class="epic-form-title">Specify Epic</span>
			<button class="epic-form-close" title="Close">&times;</button>
		</div>
		<textarea class="epic-textarea" placeholder="Describe a large feature to decompose into multiple specs..." rows="5"></textarea>
		<div class="epic-error hidden"></div>
		<div class="epic-form-actions">
			<button class="btn btn-primary epic-btn-create-start">Create + Start</button>
			<button class="btn btn-secondary epic-btn-create">Create</button>
			<button class="btn btn-danger epic-btn-cancel hidden">Cancel</button>
		</div>
		<div class="epic-analyzing hidden">
			<span class="epic-spinner"></span>
			<span>Analyzing epic...</span>
		</div>
	`;

	const btnClose = container.querySelector(".epic-form-close") as HTMLButtonElement;

	function submitEpic(autoStart: boolean) {
		const textarea = container.querySelector(".epic-textarea") as HTMLTextAreaElement;
		const desc = textarea.value.trim();
		if (desc.length < 10) {
			setEpicFormState("error", "Description must be at least 10 characters");
			return;
		}
		const targetRepo = getTargetRepo();
		send({
			type: "epic:start",
			description: desc,
			autoStart,
			...(targetRepo ? { targetRepository: targetRepo } : {}),
		});
	}

	container
		.querySelector(".epic-btn-create-start")
		?.addEventListener("click", () => submitEpic(true));
	container.querySelector(".epic-btn-create")?.addEventListener("click", () => submitEpic(false));
	container
		.querySelector(".epic-btn-cancel")
		?.addEventListener("click", () => send({ type: "epic:cancel" }));
	btnClose.addEventListener("click", () => container.classList.add("hidden"));

	return container;
}

export function showEpicForm(): void {
	const form = document.getElementById("epic-form");
	if (form) form.classList.remove("hidden");
}

export function hideEpicForm(): void {
	const form = document.getElementById("epic-form");
	if (form) form.classList.add("hidden");
}

export function setEpicFormState(state: EpicFormState, error?: string): void {
	errorMessage = error || "";

	const form = document.getElementById("epic-form");
	if (!form) return;

	const textarea = form.querySelector(".epic-textarea") as HTMLTextAreaElement;
	const btnCreateStart = form.querySelector(".epic-btn-create-start") as HTMLButtonElement;
	const btnCreate = form.querySelector(".epic-btn-create") as HTMLButtonElement;
	const btnCancel = form.querySelector(".epic-btn-cancel") as HTMLButtonElement;
	const analyzingEl = form.querySelector(".epic-analyzing") as HTMLElement;
	const errorEl = form.querySelector(".epic-error") as HTMLElement;

	const isAnalyzing = state === "analyzing";
	textarea.disabled = isAnalyzing;
	btnCreateStart.classList.toggle("hidden", isAnalyzing);
	btnCreate.classList.toggle("hidden", isAnalyzing);
	btnCancel.classList.toggle("hidden", !isAnalyzing);
	analyzingEl.classList.toggle("hidden", !isAnalyzing);

	if (state === "error") {
		errorEl.classList.remove("hidden");
		errorEl.textContent = errorMessage;
	} else {
		errorEl.classList.add("hidden");
	}

	if (state === "idle") {
		textarea.value = "";
		hideEpicForm();
	}
}
