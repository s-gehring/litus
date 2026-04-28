import { beforeEach, describe, expect, test } from "bun:test";
import { ClientStateManager } from "../../src/client/client-state-manager";
import type { ClientMessage } from "../../src/types";
import { makeWorkflowState } from "../helpers";

function withConsoleSpy<T>(fn: (logs: string[]) => T): T {
	const original = console.log;
	const logs: string[] = [];
	console.log = (...args: unknown[]) => {
		logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	};
	try {
		return fn(logs);
	} finally {
		console.log = original;
	}
}

describe("workflow routing — two workflows loaded", () => {
	let mgr: ClientStateManager;
	let sent: ClientMessage[];

	beforeEach(() => {
		sent = [];
		mgr = new ClientStateManager((m) => sent.push(m));
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-A" }),
		});
		mgr.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-B" }),
		});
	});

	test("SC-003: workflow:output for wf-A appears only in wf-A's output, never wf-B's", () => {
		mgr.handleMessage({
			type: "workflow:output",
			workflowId: "wf-A",
			text: "step complete in A",
		});

		const a = mgr.getWorkflows().get("wf-A");
		const b = mgr.getWorkflows().get("wf-B");
		expect(a?.outputLines).toHaveLength(1);
		expect((a?.outputLines[0] as { text: string }).text).toBe("step complete in A");
		expect(b?.outputLines).toHaveLength(0);
	});

	test("workflow:output for unknown workflow forwards a client:warning to the server and renders nowhere (FR-009, FR-016, edge case #1)", () => {
		const change = mgr.handleMessage({
			type: "workflow:output",
			workflowId: "wf-ghost",
			text: "stray output",
		});

		expect(sent).toContainEqual({
			type: "client:warning",
			source: "workflow",
			message: "workflow:output for unknown workflowId 'wf-ghost'",
		});
		expect(change.scope).toEqual({ entity: "none" });

		const a = mgr.getWorkflows().get("wf-A");
		const b = mgr.getWorkflows().get("wf-B");
		expect(a?.outputLines).toHaveLength(0);
		expect(b?.outputLines).toHaveLength(0);
	});

	test("SC-004: console:output renders in no UI surface and logs to dev console", () => {
		// Seed an alert and an epic to make sure console:output doesn't leak there either.
		mgr.handleMessage({ type: "epic:created", epicId: "ep-1", description: "Epic 1" });

		withConsoleSpy((logs) => {
			const change = mgr.handleMessage({ type: "console:output", text: "diagnostic-only" });

			expect(logs).toContain("[litus:console] diagnostic-only");
			expect(change.scope).toEqual({ entity: "none" });

			expect(mgr.getWorkflows().get("wf-A")?.outputLines).toHaveLength(0);
			expect(mgr.getWorkflows().get("wf-B")?.outputLines).toHaveLength(0);
			expect(mgr.getEpics().get("ep-1")?.outputLines).toHaveLength(0);
			expect(mgr.getAlerts().size).toBe(0);
		});
	});

	test("epic:output for unknown epic forwards a client:warning and renders nowhere", () => {
		mgr.handleMessage({ type: "epic:created", epicId: "ep-loaded", description: "Loaded" });

		const change = mgr.handleMessage({
			type: "epic:output",
			epicId: "ep-ghost",
			text: "stray epic output",
		});

		expect(sent).toContainEqual({
			type: "client:warning",
			source: "epic",
			message: "epic:output for unknown epicId 'ep-ghost'",
		});
		expect(change.scope).toEqual({ entity: "none" });

		expect(mgr.getEpics().get("ep-loaded")?.outputLines).toHaveLength(0);
		expect(mgr.getWorkflows().get("wf-A")?.outputLines).toHaveLength(0);
	});
});
