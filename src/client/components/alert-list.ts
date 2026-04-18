import type { Alert } from "../../types";
import type { ClientStateManager } from "../client-state-manager";
import { alertDisplayLabel } from "./alert-label";

type DismissHandler = (alertId: string) => void;
type NavigateHandler = (alert: Alert) => void;

interface AlertListDeps {
	getAlerts: () => ReadonlyMap<string, Alert>;
	getState?: () => ClientStateManager;
	onDismiss: DismissHandler;
	onNavigate: NavigateHandler;
}

let panelEl: HTMLElement | null = null;
let deps: AlertListDeps | null = null;
let outsideClickHandler: ((e: MouseEvent) => void) | null = null;

function relativeTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

function labelFor(alert: Alert): string {
	const state = deps?.getState?.();
	if (!state) return "";
	return alertDisplayLabel(alert, state);
}

function renderRows(): void {
	if (!panelEl || !deps) return;
	panelEl.replaceChildren();
	const alerts = [...deps.getAlerts().values()].sort((a, b) => b.createdAt - a.createdAt);
	if (alerts.length === 0) {
		const empty = document.createElement("div");
		empty.className = "alert-list-empty";
		empty.textContent = "No alerts";
		panelEl.appendChild(empty);
		return;
	}
	for (const a of alerts) {
		const row = document.createElement("div");
		row.className = "alert-list-row";
		row.dataset.alertId = a.id;

		const body = document.createElement("div");
		body.className = "alert-list-row-body";
		const title = document.createElement("div");
		title.className = "alert-list-row-title";
		title.textContent = a.title;
		const meta = document.createElement("div");
		meta.className = "alert-list-row-meta";
		const hint = labelFor(a);
		meta.textContent = hint ? `${hint} · ${relativeTime(a.createdAt)}` : relativeTime(a.createdAt);
		body.appendChild(title);
		body.appendChild(meta);

		const dismiss = document.createElement("button");
		dismiss.className = "alert-list-dismiss";
		dismiss.textContent = "×";
		dismiss.setAttribute("aria-label", "Dismiss alert");
		dismiss.addEventListener("click", (e) => {
			e.stopPropagation();
			deps?.onDismiss(a.id);
		});

		row.appendChild(body);
		row.appendChild(dismiss);
		row.addEventListener("click", () => {
			deps?.onNavigate(a);
			hideAlertList();
		});
		panelEl.appendChild(row);
	}
}

export function initAlertList(d: AlertListDeps): void {
	deps = d;
}

export function showAlertList(): void {
	if (!deps) return;
	if (panelEl) {
		hideAlertList();
		return;
	}
	panelEl = document.createElement("div");
	panelEl.className = "alert-list-panel";
	panelEl.id = "alert-list-panel";
	document.body.appendChild(panelEl);
	renderRows();

	outsideClickHandler = (e: MouseEvent) => {
		const target = e.target as HTMLElement | null;
		if (!panelEl || !target) return;
		if (panelEl.contains(target)) return;
		if (target.closest("#btn-alert-bell")) return;
		hideAlertList();
	};
	setTimeout(() => {
		if (outsideClickHandler) document.addEventListener("click", outsideClickHandler);
	}, 0);
}

export function hideAlertList(): void {
	panelEl?.remove();
	panelEl = null;
	if (outsideClickHandler) {
		document.removeEventListener("click", outsideClickHandler);
		outsideClickHandler = null;
	}
}

export function refreshAlertList(): void {
	if (panelEl) renderRows();
}

export function isAlertListOpen(): boolean {
	return panelEl !== null;
}
