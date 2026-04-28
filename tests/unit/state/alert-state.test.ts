import { describe, expect, test } from "bun:test";
import * as alertState from "../../../src/client/state/alert-state";
import type { Alert } from "../../../src/types";

function makeAlert(overrides?: Partial<Alert>): Alert {
	return {
		id: overrides?.id ?? "alert-1",
		type: overrides?.type ?? "epic-finished",
		title: overrides?.title ?? "Title",
		description: overrides?.description ?? "Description",
		workflowId: overrides?.workflowId ?? null,
		epicId: overrides?.epicId ?? null,
		targetRoute: overrides?.targetRoute ?? "/",
		createdAt: overrides?.createdAt ?? 1,
		seen: overrides?.seen ?? false,
	};
}

describe("alert-state reduce", () => {
	test("alert:list replaces all alerts", () => {
		const state = alertState.createState();
		state.alerts.set("old", makeAlert({ id: "old" }));

		const result = alertState.reduce(state, {
			type: "alert:list",
			alerts: [makeAlert({ id: "a1" }), makeAlert({ id: "a2" })],
		});

		expect(result.state.alerts.size).toBe(2);
		expect(result.state.alerts.has("old")).toBe(false);
		expect(result.change).toEqual({ notify: true, affectsCardOrder: false });
		expect(result.stateChange).toEqual({ scope: { entity: "global" }, action: "updated" });
	});

	test("alert:created adds an alert", () => {
		const state = alertState.createState();
		const result = alertState.reduce(state, {
			type: "alert:created",
			alert: makeAlert({ id: "new" }),
		});
		expect(result.state.alerts.has("new")).toBe(true);
		expect(result.change).toEqual({ notify: true, affectsCardOrder: false });
		expect(result.stateChange).toEqual({ scope: { entity: "global" }, action: "added" });
	});

	test("alert:dismissed removes matching alerts and notifies", () => {
		const state = alertState.createState();
		state.alerts.set("a1", makeAlert({ id: "a1" }));
		state.alerts.set("a2", makeAlert({ id: "a2" }));

		const result = alertState.reduce(state, { type: "alert:dismissed", alertIds: ["a1"] });
		expect(result.state.alerts.has("a1")).toBe(false);
		expect(result.state.alerts.has("a2")).toBe(true);
		expect(result.change.notify).toBe(true);
	});

	test("alert:dismissed with no matches does not notify", () => {
		const state = alertState.createState();
		state.alerts.set("a1", makeAlert({ id: "a1" }));
		const result = alertState.reduce(state, { type: "alert:dismissed", alertIds: ["unknown"] });
		expect(result.change.notify).toBe(false);
	});

	test("alert:seen flips seen flags and notifies when changed", () => {
		const state = alertState.createState();
		state.alerts.set("a1", makeAlert({ id: "a1", seen: false }));
		const result = alertState.reduce(state, { type: "alert:seen", alertIds: ["a1"] });
		expect(state.alerts.get("a1")?.seen).toBe(true);
		expect(result.change.notify).toBe(true);
	});

	test("alert:seen does not notify when nothing changes", () => {
		const state = alertState.createState();
		state.alerts.set("a1", makeAlert({ id: "a1", seen: true }));
		const result = alertState.reduce(state, { type: "alert:seen", alertIds: ["a1"] });
		expect(result.change.notify).toBe(false);
	});

	test("affectsCardOrder is always false for every alert message (FR-002b)", () => {
		const state = alertState.createState();
		const list = alertState.reduce(state, { type: "alert:list", alerts: [] });
		expect(list.change.affectsCardOrder).toBe(false);
		const created = alertState.reduce(state, {
			type: "alert:created",
			alert: makeAlert({ id: "x" }),
		});
		expect(created.change.affectsCardOrder).toBe(false);
		const dismissed = alertState.reduce(state, { type: "alert:dismissed", alertIds: ["x"] });
		expect(dismissed.change.affectsCardOrder).toBe(false);
		const seen = alertState.reduce(state, { type: "alert:seen", alertIds: [] });
		expect(seen.change.affectsCardOrder).toBe(false);
	});

	test("reset clears alerts and notifies", () => {
		const state = alertState.createState();
		state.alerts.set("a1", makeAlert({ id: "a1" }));
		const result = alertState.reset(state);
		expect(result.state.alerts.size).toBe(0);
		expect(result.change).toEqual({ notify: true, affectsCardOrder: false });
		expect(result.stateChange.action).toBe("cleared");
	});
});
