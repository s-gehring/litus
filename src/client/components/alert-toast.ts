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
let overflowCount = 0;
let overflowEl: HTMLElement | null = null;

function ensureContainer(): HTMLElement | null {
	if (container) return container;
	container = document.getElementById("alert-toast-container");
	return container;
}

function removeToast(t: Toast): void {
	clearTimeout(t.timer);
	t.element.remove();
	const idx = visible.indexOf(t);
	if (idx >= 0) visible.splice(idx, 1);
}

function renderOverflow(): void {
	if (!container) return;
	if (overflowCount <= 0) {
		overflowEl?.remove();
		overflowEl = null;
		return;
	}
	if (!overflowEl) {
		overflowEl = document.createElement("div");
		overflowEl.className = "alert-toast alert-toast-overflow";
		container.appendChild(overflowEl);
	}
	overflowEl.textContent = `+${overflowCount} more alert${overflowCount > 1 ? "s" : ""}`;
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
		overflowCount++;
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
}
