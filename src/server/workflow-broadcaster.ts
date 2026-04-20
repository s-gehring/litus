import { logger } from "../logger";
import type { ServerMessage, Workflow, WorkflowState } from "../types";
import type { WorkflowStore } from "../workflow-store";

/**
 * Fallback broadcaster used after `abortPipeline` deletes the orchestrator.
 * Reads the persisted workflow from disk and re-broadcasts its state so late
 * callbacks (e.g., the post-abort commit-backfill in
 * `pipeline-orchestrator.abortPipeline`) still reach the client without
 * needing a page reload.
 */
export function broadcastPersistedWorkflowState(
	workflowId: string,
	store: WorkflowStore,
	strip: (w: Workflow) => WorkflowState,
	broadcast: (msg: ServerMessage) => void,
): Promise<void> {
	return store
		.load(workflowId)
		.then((w) => {
			if (w) broadcast({ type: "workflow:state", workflow: strip(w) });
		})
		.catch((err) => {
			logger.warn(
				`[server] Failed to load persisted workflow ${workflowId} for broadcast fallback: ${err}`,
			);
		});
}
