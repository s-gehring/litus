import type { ClientMessage } from "../../types";

let getMainTargetRepo: () => string = () => "";

export function createEpicForm(
	send: (msg: ClientMessage) => void,
	getTargetRepo: () => string,
): HTMLElement {
	getMainTargetRepo = getTargetRepo;

	const container = document.createElement("div");
	container.id = "epic-form";
	container.className = "epic-form hidden";

	container.innerHTML = `
		<div class="epic-form-header">
			<span class="epic-form-title">Specify Epic</span>
			<button class="epic-form-close" title="Close">&times;</button>
		</div>
		<div class="epic-target-repo">
			<label class="epic-target-repo-label">Target Repository</label>
			<input class="epic-target-repo-input" type="text" placeholder="~/git" />
		</div>
		<textarea class="epic-textarea" placeholder="Describe a large feature to decompose into multiple specs..." rows="5"></textarea>
		<div class="epic-error hidden"></div>
		<div class="epic-form-actions">
			<button class="btn btn-primary epic-btn-create-start">Create + Start</button>
			<button class="btn btn-secondary epic-btn-create">Create</button>
		</div>
	`;

	function submitEpic(autoStart: boolean) {
		const textarea = container.querySelector(".epic-textarea") as HTMLTextAreaElement;
		const repoInput = container.querySelector(".epic-target-repo-input") as HTMLInputElement;
		const errorEl = container.querySelector(".epic-error") as HTMLElement;
		const desc = textarea.value.trim();
		if (desc.length < 10) {
			errorEl.classList.remove("hidden");
			errorEl.textContent = "Description must be at least 10 characters";
			return;
		}
		errorEl.classList.add("hidden");
		const targetRepo = repoInput.value.trim();
		send({
			type: "epic:start",
			description: desc,
			autoStart,
			...(targetRepo ? { targetRepository: targetRepo } : {}),
		});
		textarea.value = "";
	}

	container
		.querySelector(".epic-btn-create-start")
		?.addEventListener("click", () => submitEpic(true));
	container.querySelector(".epic-btn-create")?.addEventListener("click", () => submitEpic(false));
	container
		.querySelector(".epic-form-close")
		?.addEventListener("click", () => container.classList.add("hidden"));

	return container;
}

export function showEpicForm(): void {
	const form = document.getElementById("epic-form");
	if (!form) return;
	// Sync target repo from main input into epic form
	const repoInput = form.querySelector(".epic-target-repo-input") as HTMLInputElement;
	if (repoInput) repoInput.value = getMainTargetRepo();
	form.classList.remove("hidden");
}

export function hideEpicForm(): void {
	const form = document.getElementById("epic-form");
	if (form) form.classList.add("hidden");
}
