export interface ConfirmModalOptions {
	title: string;
	body: string;
	confirmLabel?: string;
	cancelLabel?: string;
}

let modalInFlight = false;

export function showConfirmModal(options: ConfirmModalOptions): Promise<boolean> {
	if (modalInFlight) return Promise.resolve(false);
	modalInFlight = true;
	return new Promise<boolean>((resolve) => {
		const backdrop = document.createElement("div");
		backdrop.className = "modal-backdrop confirm-modal-backdrop";

		const modal = document.createElement("div");
		modal.className = "confirm-modal";
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");

		const titleEl = document.createElement("div");
		titleEl.className = "confirm-modal-title";
		titleEl.textContent = options.title;
		modal.appendChild(titleEl);

		const bodyEl = document.createElement("div");
		bodyEl.className = "confirm-modal-body";
		bodyEl.textContent = options.body;
		modal.appendChild(bodyEl);

		const actions = document.createElement("div");
		actions.className = "confirm-modal-actions";
		const cancelBtn = document.createElement("button");
		cancelBtn.type = "button";
		cancelBtn.className = "btn-secondary";
		cancelBtn.textContent = options.cancelLabel ?? "Cancel";
		const confirmBtn = document.createElement("button");
		confirmBtn.type = "button";
		confirmBtn.className = "btn-primary";
		confirmBtn.textContent = options.confirmLabel ?? "Confirm";
		actions.appendChild(cancelBtn);
		actions.appendChild(confirmBtn);
		modal.appendChild(actions);

		backdrop.appendChild(modal);
		document.body.appendChild(backdrop);

		const cleanup = (result: boolean): void => {
			document.removeEventListener("keydown", onKey);
			backdrop.remove();
			modalInFlight = false;
			resolve(result);
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") cleanup(false);
			else if (e.key === "Enter") cleanup(true);
		};
		document.addEventListener("keydown", onKey);

		backdrop.addEventListener("click", (e) => {
			if (e.target === backdrop) cleanup(false);
		});
		cancelBtn.addEventListener("click", () => cleanup(false));
		confirmBtn.addEventListener("click", () => cleanup(true));

		confirmBtn.focus();
	});
}
