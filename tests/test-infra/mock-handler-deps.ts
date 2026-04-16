import type { ServerWebSocket } from "bun";
import type { ManagedRepoStore } from "../../src/managed-repo-store";
import type { HandlerDeps, WsData } from "../../src/server/handler-types";
import type { ServerMessage, Workflow, WorkflowState } from "../../src/types";
import { type CallTracker, createCallTracker } from "./call-tracker";
import { createMockConfigStore, createMockEpicStore, createMockWorkflowStore } from "./mock-stores";

function createMockManagedRepoStore(): ManagedRepoStore {
	return {
		async acquire(_submissionId: string, _rawUrl: string) {
			throw new Error("managedRepoStore.acquire not mocked — pass an override");
		},
		async release() {},
		async bumpRefCount() {},
		async seedFromWorkflows() {},
		async tryAttachByPath() {
			return null;
		},
	} as unknown as ManagedRepoStore;
}

export interface MockHandlerDeps {
	deps: HandlerDeps;
	tracker: CallTracker;
	broadcastedMessages: ServerMessage[];
	sentMessages: Map<ServerWebSocket<WsData>, ServerMessage[]>;
	orchestrators: HandlerDeps["orchestrators"];
}

export function createMockHandlerDeps(overrides?: Partial<HandlerDeps>): MockHandlerDeps {
	const tracker = createCallTracker();
	const broadcastedMessages: ServerMessage[] = [];
	const sentMessages = new Map<ServerWebSocket<WsData>, ServerMessage[]>();
	const orchestrators = overrides?.orchestrators ?? new Map();
	const mockStore = createMockWorkflowStore();
	const mockEpicStore = createMockEpicStore();
	const mockConfigStore = createMockConfigStore();

	const deps: HandlerDeps = {
		orchestrators,
		broadcast(msg: ServerMessage) {
			tracker.calls.push({ method: "broadcast", args: [msg] });
			broadcastedMessages.push(msg);
		},
		sendTo(ws: ServerWebSocket<WsData>, msg: ServerMessage) {
			tracker.calls.push({ method: "sendTo", args: [ws, msg] });
			const existing = sentMessages.get(ws) ?? [];
			existing.push(msg);
			sentMessages.set(ws, existing);
		},
		sharedStore: mockStore.mock as unknown as HandlerDeps["sharedStore"],
		sharedEpicStore: mockEpicStore.mock as unknown as HandlerDeps["sharedEpicStore"],
		sharedAuditLogger: {
			removeAll() {},
		} as unknown as HandlerDeps["sharedAuditLogger"],
		sharedCliRunner: {} as unknown as HandlerDeps["sharedCliRunner"],
		sharedSummarizer: {} as unknown as HandlerDeps["sharedSummarizer"],
		configStore: mockConfigStore.mock as unknown as HandlerDeps["configStore"],
		managedRepoStore: createMockManagedRepoStore(),
		epicAnalysisRef: { current: null },
		createOrchestrator: (() => {
			throw new Error("createOrchestrator not mocked");
		}) as unknown as HandlerDeps["createOrchestrator"],
		broadcastWorkflowState(workflowId: string) {
			tracker.calls.push({ method: "broadcastWorkflowState", args: [workflowId] });
		},
		stripInternalFields(w: Workflow): WorkflowState {
			const { steps, ...rest } = w;
			return {
				...rest,
				steps: steps.map(({ sessionId: _sid, prompt: _p, pid: _pid, ...step }) => step),
			};
		},
		async getAllWorkflowStates(): Promise<WorkflowState[]> {
			return [];
		},
		...overrides,
	};

	return { deps, tracker, broadcastedMessages, sentMessages, orchestrators };
}
