import type { Alert } from "../../types";

const MAX_VISIBLE = 3;
const AUTO_DISMISS_MS = 5000;

type ClickHandler = (alert: Alert) => void;

interface Toast {
	alert: Alert;
	element: HTMLElement;
	timer: ReturnType<typeof setTimeout>;
}

let container: HTMLElement | null = null;
let onClick: ClickHandler = () => {};
const visible: Toast[] = [];
const overflowQueue: Alert[] = [];
let overflowEl: HTMLElement | null = null;
let overflowTimer: ReturnType<typeof setTimeout> | null = null;

function ensureContainer(): HTMLElement | null {
	if (container) return container;
	container = document.getElementById("alert-toast-container");
	return container;
}

function clearOverflow(): void {
	overflowQueue.length = 0;
	if (overflowTimer) {
		clearTimeout(overflowTimer);
		overflowTimer = null;
	}
	overflowEl?.remove();
	overflowEl = null;
}

function removeToast(t: Toast): void {
	clearTimeout(t.timer);
	t.element.remove();
	const idx = visible.indexOf(t);
	if (idx >= 0) visible.splice(idx, 1);
	// Promote the oldest overflowed alert into a real toast if there's room.
	if (overflowQueue.length > 0 && visible.length < MAX_VISIBLE) {
		const next = overflowQueue.shift();
		if (next) showAlertToast(next);
	}
	renderOverflow();
}

function renderOverflow(): void {
	if (!container) return;
	if (overflowQueue.length <= 0) {
		clearOverflow();
		return;
	}
	if (!overflowEl) {
		overflowEl = document.createElement("div");
		overflowEl.className = "alert-toast alert-toast-overflow";
		overflowEl.addEventListener("click", clearOverflow);
		container.appendChild(overflowEl);
	}
	overflowEl.textContent = `+${overflowQueue.length} more alert${overflowQueue.length > 1 ? "s" : ""}`;
	if (overflowTimer) clearTimeout(overflowTimer);
	overflowTimer = setTimeout(clearOverflow, AUTO_DISMISS_MS);
}

function buildToastElement(alert: Alert): HTMLElement {
	const el = document.createElement("div");
	el.className = `alert-toast alert-toast-${alert.type}`;
	el.dataset.alertId = alert.id;

	const title = document.createElement("div");
	title.className = "alert-toast-title";
	title.textContent = alert.title;

	const desc = document.createElement("div");
	desc.className = "alert-toast-description";
	desc.textContent = alert.description;

	el.appendChild(title);
	el.appendChild(desc);

	el.addEventListener("click", () => {
		onClick(alert);
	});
	return el;
}

export function initAlertToasts(handler: ClickHandler): void {
	onClick = handler;
	ensureContainer();
}

export function showAlertToast(alert: Alert): void {
	const root = ensureContainer();
	if (!root) return;

	if (visible.length >= MAX_VISIBLE) {
		overflowQueue.push(alert);
		renderOverflow();
		return;
	}

	const element = buildToastElement(alert);
	const toast: Toast = {
		alert,
		element,
		timer: setTimeout(() => removeToast(toast), AUTO_DISMISS_MS),
	};
	root.appendChild(element);
	visible.push(toast);
}

export function removeAlertToast(alertId: string): void {
	const t = visible.find((v) => v.alert.id === alertId);
	if (t) removeToast(t);
	const idx = overflowQueue.findIndex((a) => a.id === alertId);
	if (idx >= 0) {
		overflowQueue.splice(idx, 1);
		renderOverflow();
	}
}
