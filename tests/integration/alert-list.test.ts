import { beforeEach, describe, expect, test } from "bun:test";
import "../happydom";
import { ClientStateManager } from "../../src/client/client-state-manager";
import {
	hideAlertList,
	initAlertList,
	refreshAlertList,
	showAlertList,
} from "../../src/client/components/alert-list";
import type { Alert } from "../../src/types";
import { makeWorkflowState } from "../helpers";

function makeAlert(overrides: Partial<Alert> = {}): Alert {
	return {
		id: "alert_1",
		type: "workflow-finished",
		title: "Something happened",
		description: "Details",
		workflowId: null,
		epicId: null,
		targetRoute: "",
		createdAt: Date.now() - 5_000,
		seen: false,
		...overrides,
	};
}

describe("alert-list row meta rendering", () => {
	beforeEach(() => {
		hideAlertList();
		document.body.replaceChildren();
	});

	test("shows the workflow summary in the meta row when the workflow resolves", () => {
		const mgr = new ClientStateManager();
		mgr.handleMessage({
			type: "workflow:list",
			workflows: [
				makeWorkflowState({
					id: "wf-known",
					summary: "Add dark mode toggle",
				}),
			],
		});
		const alerts = new Map<string, Alert>();
		const a = makeAlert({
			id: "alert_known",
			workflowId: "wf-known",
			title: "Workflow finished",
		});
		alerts.set(a.id, a);
		// Also register the alert in the state manager so the panel can read it.
		mgr.handleMessage({ type: "alert:list", alerts: [a] });

		initAlertList({
			getAlerts: () => mgr.getAlerts(),
			getState: () => mgr,
			onDismiss: () => {},
			onNavigate: () => {},
		});

		showAlertList();
		refreshAlertList();

		const meta = document.querySelector(".alert-list-row-meta");
		expect(meta).not.toBeNull();
		const text = meta?.textContent ?? "";
		expect(text).toContain("Add dark mode toggle");
		expect(text).not.toMatch(/workflow [0-9a-f]{8}/);
	});

	test("renders 'Clear all' button when onClearAll is provided and alerts exist", () => {
		const mgr = new ClientStateManager();
		const a = makeAlert({ id: "alert_clear_1" });
		mgr.handleMessage({ type: "alert:list", alerts: [a] });

		let cleared = 0;
		initAlertList({
			getAlerts: () => mgr.getAlerts(),
			getState: () => mgr,
			onDismiss: () => {},
			onNavigate: () => {},
			onClearAll: () => {
				cleared++;
			},
		});

		showAlertList();
		refreshAlertList();

		const btn = document.querySelector<HTMLButtonElement>(".alert-list-clear-all");
		expect(btn).not.toBeNull();
		btn?.click();
		expect(cleared).toBe(1);
	});

	test("does not render 'Clear all' button when alert list is empty", () => {
		const mgr = new ClientStateManager();
		mgr.handleMessage({ type: "alert:list", alerts: [] });

		initAlertList({
			getAlerts: () => mgr.getAlerts(),
			getState: () => mgr,
			onDismiss: () => {},
			onNavigate: () => {},
			onClearAll: () => {},
		});

		showAlertList();
		refreshAlertList();

		expect(document.querySelector(".alert-list-clear-all")).toBeNull();
		expect(document.querySelector(".alert-list-empty")).not.toBeNull();
	});

	test("omits 'Clear all' button when onClearAll is not wired", () => {
		const mgr = new ClientStateManager();
		const a = makeAlert({ id: "alert_no_clear" });
		mgr.handleMessage({ type: "alert:list", alerts: [a] });

		initAlertList({
			getAlerts: () => mgr.getAlerts(),
			getState: () => mgr,
			onDismiss: () => {},
			onNavigate: () => {},
		});

		showAlertList();
		refreshAlertList();

		expect(document.querySelector(".alert-list-clear-all")).toBeNull();
	});

	test("seen rows receive .alert-list-row--seen, unseen rows do not, click still dismisses", () => {
		const mgr = new ClientStateManager();
		const seen = makeAlert({ id: "alert_seen", title: "Seen row", seen: true });
		const unseen = makeAlert({ id: "alert_unseen", title: "Unseen row", seen: false });
		mgr.handleMessage({ type: "alert:list", alerts: [seen, unseen] });

		const state: { dismissed: string | null; navigated: string | null } = {
			dismissed: null,
			navigated: null,
		};
		initAlertList({
			getAlerts: () => mgr.getAlerts(),
			getState: () => mgr,
			onDismiss: (id) => {
				state.dismissed = id;
			},
			onNavigate: (a) => {
				state.navigated = a.id;
			},
		});

		showAlertList();
		refreshAlertList();

		const rows = document.querySelectorAll<HTMLElement>(".alert-list-row");
		expect(rows).toHaveLength(2);
		const seenRow = [...rows].find((r) => r.dataset.alertId === "alert_seen");
		const unseenRow = [...rows].find((r) => r.dataset.alertId === "alert_unseen");
		expect(seenRow?.classList.contains("alert-list-row--seen")).toBe(true);
		expect(unseenRow?.classList.contains("alert-list-row--seen")).toBe(false);

		// The alert-list component fires onNavigate on every row click; the
		// production wiring (app.ts) pairs `onNavigate` with a
		// `send(alert:dismiss)` so FR-011 ("remove entirely") flows through the
		// WebSocket — see the "row click wired to send(alert:dismiss) …" test
		// below for the full path-level contract.
		seenRow?.click();
		expect(state.navigated).toBe("alert_seen");
		// Dismiss button still works on seen rows.
		seenRow?.querySelector<HTMLButtonElement>(".alert-list-dismiss")?.click();
		expect(state.dismissed).toBe("alert_seen");
	});

	test("row click wired to send(alert:dismiss) removes error alerts from the list (US3 scenario 2, FR-011)", () => {
		const mgr = new ClientStateManager();
		const err = makeAlert({ id: "alert_err", type: "error", title: "Boom", seen: false });
		mgr.handleMessage({ type: "alert:list", alerts: [err] });

		const sent: Array<{ type: string; alertId: string }> = [];
		initAlertList({
			getAlerts: () => mgr.getAlerts(),
			getState: () => mgr,
			onDismiss: () => {},
			// Production wiring (see app.ts): onNavigate → send(alert:dismiss)
			// + navigateToAlertTarget. We emulate the first half here.
			onNavigate: (a) => {
				sent.push({ type: "alert:dismiss", alertId: a.id });
				// Server-side: dismiss drops the alert from state and broadcasts.
				mgr.handleMessage({ type: "alert:dismissed", alertIds: [a.id] });
			},
		});

		showAlertList();
		refreshAlertList();

		const row = document.querySelector<HTMLElement>('[data-alert-id="alert_err"]');
		expect(row).not.toBeNull();
		row?.click();

		expect(sent).toEqual([{ type: "alert:dismiss", alertId: "alert_err" }]);
		expect(mgr.getAlerts().has("alert_err")).toBe(false);
	});

	test("does not show any hash hint when the workflow is missing from state", () => {
		const mgr = new ClientStateManager();
		const a = makeAlert({
			id: "alert_unknown",
			workflowId: "wf-deadbeef01",
			title: "Orphan alert",
		});
		mgr.handleMessage({ type: "alert:list", alerts: [a] });

		initAlertList({
			getAlerts: () => mgr.getAlerts(),
			getState: () => mgr,
			onDismiss: () => {},
			onNavigate: () => {},
		});

		showAlertList();
		refreshAlertList();

		const meta = document.querySelector(".alert-list-row-meta");
		expect(meta).not.toBeNull();
		const text = meta?.textContent ?? "";
		expect(text).not.toContain("deadbeef");
		expect(text).not.toMatch(/workflow [0-9a-f]{8}/);
	});
});
