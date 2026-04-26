import { logger } from "./logger";
import type { HandlerDeps } from "./server/handler-types";
import { loadWorkflowForArchive, persistArchiveFlip } from "./server/workflow-handlers";
import type { PersistedEpic, Workflow } from "./types";

export const AUTO_ARCHIVE_THRESHOLD_MS = 30_000;
export const AUTO_ARCHIVE_SWEEP_INTERVAL_MS = 10_000;

function isTerminalWorkflow(status: Workflow["status"]): boolean {
	return status === "completed" || status === "aborted" || status === "error";
}

function isTerminalEpic(status: PersistedEpic["status"]): boolean {
	return status === "completed" || status === "error" || status === "infeasible";
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
		// Kick off an initial sweep so existing already-done workflows/epics
		// don't have to wait `intervalMs` after server start before being
		// archived. This is what catches the backlog accrued before the
		// auto-archive feature shipped.
		void this.sweep();
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
			const [workflows, epics] = await Promise.all([
				this.deps.sharedStore.loadAll(),
				this.deps.sharedEpicStore.loadAll(),
			]);
			const now = Date.now();

			// Pass 1: archive eligible epics (cascades to all children, even
			// non-terminal idle/waiting ones — terminal epics shouldn't have
			// running children, but if they do we skip the epic defensively).
			const archivedEpicIds = new Set<string>();
			for (const epic of epics) {
				if (epic.archived) continue;
				if (!isTerminalEpic(epic.status)) continue;
				if (!epic.completedAt) continue;
				const completedMs = Date.parse(epic.completedAt);
				if (!Number.isFinite(completedMs)) continue;
				if (now - completedMs < this.thresholdMs) continue;
				const children = workflows.filter((w) => w.epicId === epic.epicId);
				if (children.some((c) => c.status === "running")) continue;
				const ok = await this.archiveEpic(epic, children);
				if (ok) archivedEpicIds.add(epic.epicId);
			}

			// Pass 2: archive standalone (non-epic-child) terminal workflows.
			for (const w of workflows) {
				if (w.archived) continue;
				if (w.epicId !== null) continue;
				if (!isTerminalWorkflow(w.status)) continue;
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
		if (!isTerminalWorkflow(workflow.status)) return;
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

	private async archiveEpic(epic: PersistedEpic, children: Workflow[]): Promise<boolean> {
		const archivedAt = new Date().toISOString();
		const epicSnapshot = { archived: epic.archived, archivedAt: epic.archivedAt };
		epic.archived = true;
		epic.archivedAt = archivedAt;
		try {
			await this.deps.sharedEpicStore.save(epic);
		} catch (err) {
			epic.archived = epicSnapshot.archived;
			epic.archivedAt = epicSnapshot.archivedAt;
			logger.error(`[auto-archive] persist failed for epic ${epic.epicId}: ${err}`);
			return false;
		}

		const archivedChildren: Workflow[] = [];
		for (const child of children) {
			if (child.archived) continue;
			try {
				await persistArchiveFlip(
					child,
					{ archived: true, archivedAt, updatedAt: archivedAt },
					this.deps,
				);
				archivedChildren.push(child);
			} catch (err) {
				logger.error(`[auto-archive] persist failed for child ${child.id}: ${err}`);
			}
		}

		this.deps.sharedAuditLogger.logArchiveEvent({
			eventType: "epic.archive",
			pipelineName: `epic-${epic.epicId}`,
			workflowId: null,
			epicId: epic.epicId,
		});

		const allEpics = await this.deps.sharedEpicStore.loadAll();
		this.deps.broadcast({ type: "epic:list", epics: allEpics });
		for (const child of archivedChildren) {
			this.deps.broadcast({
				type: "workflow:state",
				workflow: this.deps.stripInternalFields(child),
			});
		}
		logger.info(
			`[auto-archive] archived epic ${epic.epicId} (children=${archivedChildren.length})`,
		);
		return true;
	}
}
