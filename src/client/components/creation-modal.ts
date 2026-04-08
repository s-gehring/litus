let activeModal: { hide: () => void } | null = null;

export interface Modal {
	element: HTMLElement;
	show: () => void;
	hide: () => void;
}

export function createModal(title: string, content: HTMLElement): Modal {
	const overlay = document.createElement("div");
	overlay.className = "modal-overlay";

	const panel = document.createElement("div");
	panel.className = "modal-panel";
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-modal", "true");
	panel.setAttribute("aria-label", title);

	const header = document.createElement("div");
	header.className = "modal-header";

	const titleEl = document.createElement("span");
	titleEl.className = "modal-title";
	titleEl.textContent = title;

	const closeBtn = document.createElement("button");
	closeBtn.className = "modal-close";
	closeBtn.title = "Close";
	closeBtn.textContent = "\u00d7";

	header.appendChild(titleEl);
	header.appendChild(closeBtn);

	const body = document.createElement("div");
	body.className = "modal-body";
	body.appendChild(content);

	panel.appendChild(header);
	panel.appendChild(body);
	overlay.appendChild(panel);

	// Close only when both mousedown and mouseup happen on the overlay
	// (prevents closing when dragging from inside the panel to outside)
	let mousedownOnOverlay = false;
	overlay.addEventListener("mousedown", (e) => {
		mousedownOnOverlay = e.target === overlay;
	});
	overlay.addEventListener("mouseup", (e) => {
		if (mousedownOnOverlay && e.target === overlay) hide();
		mousedownOnOverlay = false;
	});

	// Close button
	closeBtn.addEventListener("click", () => hide());

	function onKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			hide();
			return;
		}

		// Focus trap: cycle Tab within the panel
		if (e.key === "Tab") {
			const focusable = panel.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			);
			if (focusable.length === 0) return;

			const first = focusable[0];
			const last = focusable[focusable.length - 1];

			if (e.shiftKey) {
				if (document.activeElement === first) {
					e.preventDefault();
					last.focus();
				}
			} else {
				if (document.activeElement === last) {
					e.preventDefault();
					first.focus();
				}
			}
		}
	}

	function show() {
		// Only one modal at a time
		if (activeModal) activeModal.hide();

		document.body.appendChild(overlay);
		// Trigger transition after insertion
		requestAnimationFrame(() => {
			overlay.classList.add("modal-visible");
		});
		document.addEventListener("keydown", onKeydown);
		activeModal = modal;

		// Focus the first focusable element in the panel
		const first = panel.querySelector<HTMLElement>(
			"input, textarea, button:not(.modal-close), select",
		);
		if (first) {
			requestAnimationFrame(() => first.focus());
		}
	}

	function hide() {
		overlay.classList.remove("modal-visible");
		document.removeEventListener("keydown", onKeydown);
		if (activeModal === modal) activeModal = null;

		// Remove after transition
		overlay.addEventListener(
			"transitionend",
			() => {
				if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
			},
			{ once: true },
		);

		// Fallback if no transition fires
		setTimeout(() => {
			if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
		}, 300);
	}

	const modal: Modal = { element: overlay, show, hide };
	return modal;
}
