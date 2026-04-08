import { describe, expect, test } from "bun:test";
import { ClientStateManager } from "../../src/client/client-state-manager";
import { MessageDispatcher } from "../../src/client/message-dispatcher";
import type { ServerMessage, StateChange } from "../../src/types";
import { makeWorkflowState } from "../helpers";
import { makeAppConfig, makePersistedEpic } from "../test-infra/factories";

function createDispatcher() {
	const stateManager = new ClientStateManager();
	const dispatcher = new MessageDispatcher(stateManager);
	return { stateManager, dispatcher };
}

// T030: dispatcher routing for all message types
describe("dispatcher routing", () => {
	test("workflow:list routes through state manager", () => {
		const { dispatcher, stateManager } = createDispatcher();
		const change = dispatcher.dispatch({
			type: "workflow:list",
			workflows: [makeWorkflowState({ id: "wf-1" })],
		});

		expect(change.scope).toEqual({ entity: "global" });
		expect(change.action).toBe("updated");
		expect(stateManager.getWorkflows().size).toBe(1);
	});

	test("workflow:created routes through state manager", () => {
		const { dispatcher, stateManager } = createDispatcher();
		const change = dispatcher.dispatch({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		expect(change.scope).toEqual({ entity: "workflow", id: "wf-1" });
		expect(change.action).toBe("added");
		expect(stateManager.getWorkflows().has("wf-1")).toBe(true);
	});

	test("workflow:state routes through state manager", () => {
		const { dispatcher, stateManager } = createDispatcher();
		stateManager.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1", status: "idle" }),
		});

		const change = dispatcher.dispatch({
			type: "workflow:state",
			workflow: makeWorkflowState({ id: "wf-1", status: "running" }),
		});

		expect(change.scope).toEqual({ entity: "workflow", id: "wf-1" });
		expect(change.action).toBe("updated");
	});

	test("workflow:output routes through state manager", () => {
		const { dispatcher, stateManager } = createDispatcher();
		stateManager.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		const change = dispatcher.dispatch({
			type: "workflow:output",
			workflowId: "wf-1",
			text: "hello",
		});

		expect(change.scope).toEqual({ entity: "output", id: "wf-1" });
		expect(change.action).toBe("appended");
	});

	test("epic:created routes through state manager", () => {
		const { dispatcher, stateManager } = createDispatcher();
		const change = dispatcher.dispatch({
			type: "epic:created",
			epicId: "e-1",
			description: "test",
		});

		expect(change.scope).toEqual({ entity: "epic", id: "e-1" });
		expect(change.action).toBe("added");
		expect(stateManager.getEpics().has("e-1")).toBe(true);
	});

	test("purge:complete routes through state manager", () => {
		const { dispatcher, stateManager } = createDispatcher();
		// Add some state first
		stateManager.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		const change = dispatcher.dispatch({
			type: "purge:complete",
			warnings: [],
		});

		expect(change.scope).toEqual({ entity: "global" });
		expect(change.action).toBe("cleared");
		expect(stateManager.getWorkflows().size).toBe(0);
	});

	test("config:state routes through state manager", () => {
		const { dispatcher } = createDispatcher();
		const change = dispatcher.dispatch({
			type: "config:state",
			config: makeAppConfig(),
		});

		expect(change.scope).toEqual({ entity: "config" });
		expect(change.action).toBe("updated");
	});

	test("log routes through state manager", () => {
		const { dispatcher } = createDispatcher();
		const change = dispatcher.dispatch({ type: "log", text: "info" });

		expect(change.scope).toEqual({ entity: "none" });
		expect(change.action).toBe("updated");
	});

	test("error routes through state manager", () => {
		const { dispatcher } = createDispatcher();
		const change = dispatcher.dispatch({ type: "error", message: "err" });

		expect(change.scope).toEqual({ entity: "none" });
		expect(change.action).toBe("updated");
	});
});

// T031: dispatcher listener notification
describe("dispatcher listener notification", () => {
	test("view callback receives StateChange and original message", () => {
		const { dispatcher } = createDispatcher();
		const received: { change: StateChange; msg: ServerMessage }[] = [];

		dispatcher.onViewUpdate((change, msg) => {
			received.push({ change, msg });
		});

		const msg: ServerMessage = {
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		};
		dispatcher.dispatch(msg);

		expect(received).toHaveLength(1);
		expect(received[0].change.scope).toEqual({ entity: "workflow", id: "wf-1" });
		expect(received[0].msg.type).toBe("workflow:created");
	});

	test("listener fires for each dispatched message", () => {
		const { dispatcher, stateManager } = createDispatcher();
		let callCount = 0;
		dispatcher.onViewUpdate(() => {
			callCount++;
		});

		stateManager.handleMessage({
			type: "workflow:created",
			workflow: makeWorkflowState({ id: "wf-1" }),
		});

		dispatcher.dispatch({ type: "workflow:output", workflowId: "wf-1", text: "a" });
		dispatcher.dispatch({ type: "workflow:output", workflowId: "wf-1", text: "b" });
		dispatcher.dispatch({ type: "log", text: "info" });

		expect(callCount).toBe(3);
	});
});

// T032: dispatcher edge cases
describe("dispatcher edge cases", () => {
	test("no listener registered does not throw", () => {
		const { dispatcher } = createDispatcher();
		expect(() => {
			dispatcher.dispatch({
				type: "workflow:created",
				workflow: makeWorkflowState({ id: "wf-1" }),
			});
		}).not.toThrow();
	});

	test("output for unknown workflow produces none scope", () => {
		const { dispatcher } = createDispatcher();
		const received: StateChange[] = [];
		dispatcher.onViewUpdate((change) => {
			received.push(change);
		});

		dispatcher.dispatch({
			type: "workflow:output",
			workflowId: "nonexistent",
			text: "hello",
		});

		expect(received).toHaveLength(1);
		expect(received[0].scope).toEqual({ entity: "none" });
	});
});
