import { AsyncLocalStorage } from "node:async_hooks";

// Tracks the active workflow ID across async boundaries so diagnostic logs
// (e.g., gitSpawn output) can be attributed to the workflow that triggered
// them instead of being broadcast globally and appended to every open
// workflow window.
const store = new AsyncLocalStorage<string>();

export function runInWorkflowContext<T>(workflowId: string, fn: () => T): T {
	return store.run(workflowId, fn);
}

export function getCurrentWorkflowId(): string | undefined {
	return store.getStore();
}
