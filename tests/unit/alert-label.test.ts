import { describe, expect, test } from "bun:test";
import "../happydom";
import { ClientStateManager } from "../../src/client/client-state-manager";
import { alertDisplayLabel } from "../../src/client/components/alert-label";
import type { Alert } from "../../src/types";
import { makeWorkflowState } from "../helpers";
import { makePersistedEpic } from "../test-infra/factories";

function makeAlert(overrides: Partial<Alert> = {}): Alert {
	return {
		id: "alert_01abcdefabcdefabcdefabcdef",
		type: "workflow-finished",
		title: "Something happened",
		description: "Details",
		workflowId: null,
		epicId: null,
		targetRoute: "",
		createdAt: Date.now(),
		seen: false,
		...overrides,
	};
}

function managerWithWorkflows(
	...wfOverrides: Parameters<typeof makeWorkflowState>[0][]
): ClientStateManager {
	const mgr = new ClientStateManager();
	const workflows = wfOverrides.map((o) => makeWorkflowState(o));
	mgr.handleMessage({ type: "workflow:list", workflows });
	return mgr;
}

describe("alertDisplayLabel", () => {
	test("returns the workflow summary when present", () => {
		const mgr = managerWithWorkflows({
			id: "wf-abcdef12",
			summary: "Add dark mode toggle",
			specification: "Long spec...",
		});
		const alert = makeAlert({ workflowId: "wf-abcdef12" });
		expect(alertDisplayLabel(alert, mgr)).toBe("Add dark mode toggle");
	});

	test("falls back to first line of specification when summary is empty", () => {
		const mgr = managerWithWorkflows({
			id: "wf-abcdef12",
			summary: "",
			specification: "First line here\nSecond line\nThird line",
		});
		const alert = makeAlert({ workflowId: "wf-abcdef12" });
		expect(alertDisplayLabel(alert, mgr)).toBe("First line here");
	});

	test("truncates specification first line with ellipsis when longer than maxLen", () => {
		const longLine = "x".repeat(200);
		const mgr = managerWithWorkflows({
			id: "wf-abcdef12",
			summary: "",
			specification: longLine,
		});
		const alert = makeAlert({ workflowId: "wf-abcdef12" });
		const out = alertDisplayLabel(alert, mgr, 60);
		expect(out.length).toBe(60);
		expect(out.endsWith("\u2026")).toBe(true);
	});

	test("returns empty string when workflowId does not resolve", () => {
		const mgr = managerWithWorkflows();
		const alert = makeAlert({ workflowId: "wf-unknown" });
		expect(alertDisplayLabel(alert, mgr)).toBe("");
	});

	test("uses epic aggregate title for epic-only alert when aggregate exists", () => {
		const mgr = managerWithWorkflows({
			id: "wf-child",
			epicId: "epic-1",
			epicTitle: "Agg Epic Title",
			status: "completed",
		});
		const alert = makeAlert({ epicId: "epic-1" });
		expect(alertDisplayLabel(alert, mgr)).toBe("Agg Epic Title");
	});

	test("falls back to epic analysis title when no aggregate", () => {
		const mgr = new ClientStateManager();
		mgr.handleMessage({
			type: "epic:list",
			epics: [
				makePersistedEpic({
					epicId: "epic-analysis-only",
					title: "Analysis Epic Title",
					status: "completed",
				}),
			],
		});
		const alert = makeAlert({ epicId: "epic-analysis-only" });
		expect(alertDisplayLabel(alert, mgr)).toBe("Analysis Epic Title");
	});

	test("returns empty string for alert with neither workflowId nor epicId", () => {
		const mgr = new ClientStateManager();
		const alert = makeAlert();
		expect(alertDisplayLabel(alert, mgr)).toBe("");
	});

	test("returns empty string for an epic-only alert whose epicId is unknown", () => {
		const mgr = new ClientStateManager();
		const alert = makeAlert({ epicId: "epic-unknown" });
		expect(alertDisplayLabel(alert, mgr)).toBe("");
	});

	test("falls through to epic title when workflowId is set but unknown", () => {
		const mgr = new ClientStateManager();
		mgr.handleMessage({
			type: "epic:list",
			epics: [
				makePersistedEpic({
					epicId: "epic-X",
					title: "Epic X",
					status: "completed",
				}),
			],
		});
		const alert = makeAlert({ workflowId: "wf-orphan", epicId: "epic-X" });
		expect(alertDisplayLabel(alert, mgr)).toBe("Epic X");
	});

	test("summary longer than maxLen is truncated to exactly maxLen with trailing ellipsis", () => {
		const longSummary = "s".repeat(100);
		const mgr = managerWithWorkflows({
			id: "wf-long",
			summary: longSummary,
		});
		const alert = makeAlert({ workflowId: "wf-long" });
		const out = alertDisplayLabel(alert, mgr, 20);
		expect(out.length).toBe(20);
		expect(out.endsWith("\u2026")).toBe(true);
	});

	test("never returns any substring of workflowId/epicId/alert.id or 'workflow <hex>'", () => {
		const mgr = managerWithWorkflows({
			id: "wf-abcdef12",
			summary: "Real summary",
		});
		const alert = makeAlert({
			id: "alert_deadbeef12345678",
			workflowId: "wf-abcdef12",
			epicId: "epic-01234567",
		});
		const out = alertDisplayLabel(alert, mgr);
		expect(out).not.toContain("abcdef12");
		expect(out).not.toContain("01234567");
		expect(out).not.toContain("deadbeef");
		expect(out).not.toMatch(/workflow [0-9a-f]{8}/);
	});

	test("uses default maxLen of 60 when omitted", () => {
		const longSummary = "a".repeat(100);
		const mgr = managerWithWorkflows({
			id: "wf-x",
			summary: longSummary,
		});
		const alert = makeAlert({ workflowId: "wf-x" });
		const out = alertDisplayLabel(alert, mgr);
		expect(out.length).toBe(60);
	});
});
