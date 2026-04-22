import { logger } from "./logger";
import type { HandlerDeps } from "./server/handler-types";
import { loadWorkflowForArchive, persistArchiveFlip } from "./server/workflow-handlers";
import type { Workflow } from "./types";

export const AUTO_ARCHIVE_THRESHOLD_MS = 30_000;
export const AUTO_ARCHIVE_SWEEP_INTERVAL_MS = 10_000;

function isTerminal(status: Workflow["status"]): boolean {
	return status === "completed" || status === "aborted" || status === "error";
}

export class AutoArchiver {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private stoppedByUser = false;

	constructor(
		private readonly deps: HandlerDeps,
		private readonly thresholdMs: number = AUTO_ARCHIVE_THRESHOLD_MS,
		private readonly intervalMs: number = AUTO_ARCHIVE_SWEEP_INTERVAL_MS,
	) {}

	start(): void {
		if (this.timer) return;
		this.stoppedByUser = false;
		this.timer = setInterval(() => {
			void this.sweep();
		}, this.intervalMs);
		// Unref the interval so it doesn't keep the process alive on its own.
		this.timer.unref?.();
		logger.info(`[auto-archive] sweeper started (threshold=${this.thresholdMs}ms)`);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
		this.stoppedByUser = true;
		logger.info("[auto-archive] sweeper stopped by user");
	}

	isActive(): boolean {
		return this.timer !== null;
	}

	wasStoppedByUser(): boolean {
		return this.stoppedByUser;
	}

	async sweep(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const workflows = await this.deps.sharedStore.loadAll();
			const now = Date.now();
			for (const w of workflows) {
				if (w.archived) continue;
				if (w.epicId !== null) continue; // epic children archive with the epic
				if (!isTerminal(w.status)) continue;
				const updatedAtMs = Date.parse(w.updatedAt);
				if (!Number.isFinite(updatedAtMs)) continue;
				if (now - updatedAtMs < this.thresholdMs) continue;
				await this.archiveOne(w.id);
			}
		} catch (err) {
			logger.error(`[auto-archive] sweep failed: ${err}`);
		} finally {
			this.running = false;
		}
	}

	private async archiveOne(workflowId: string): Promise<void> {
		const workflow = await loadWorkflowForArchive(workflowId, this.deps);
		if (!workflow) return;
		if (workflow.archived) return;
		if (workflow.epicId !== null) return;
		if (!isTerminal(workflow.status)) return;
		const archivedAt = new Date().toISOString();
		try {
			await persistArchiveFlip(
				workflow,
				{ archived: true, archivedAt, updatedAt: archivedAt },
				this.deps,
			);
		} catch (err) {
			logger.error(`[auto-archive] persist failed for ${workflowId}: ${err}`);
			return;
		}
		this.deps.sharedAuditLogger.logArchiveEvent({
			eventType: "workflow.archive",
			pipelineName: workflow.featureBranch ?? workflow.worktreeBranch ?? workflow.id,
			workflowId: workflow.id,
			epicId: workflow.epicId,
		});
		this.deps.broadcast({
			type: "workflow:state",
			workflow: this.deps.stripInternalFields(workflow),
		});
		logger.info(`[auto-archive] archived ${workflow.id} (status=${workflow.status})`);
	}
}
