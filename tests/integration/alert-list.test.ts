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
