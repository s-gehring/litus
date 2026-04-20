import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AsyncLock } from "./async-lock";
import { atomicWrite } from "./atomic-write";
import { logger } from "./logger";
import type { Workflow, WorkflowIndexEntry } from "./types";

export class WorkflowStore {
	private baseDir: string;
	private indexLock = new AsyncLock();
	private writeLocks: Map<string, Promise<void>> = new Map();

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".litus", "workflows");
	}

	private ensureDir(): void {
		mkdirSync(this.baseDir, { recursive: true });
	}

	private workflowPath(id: string): string {
		return join(this.baseDir, `${id}.json`);
	}

	private indexPath(): string {
		return join(this.baseDir, "index.json");
	}

	async save(workflow: Workflow): Promise<void> {
		await this.withWriteLock(workflow.id, async () => {
			this.ensureDir();
			const data = JSON.stringify(workflow, null, 2);
			await atomicWrite(this.workflowPath(workflow.id), data);
			await this.updateIndex(workflow);
		});
	}

	/**
	 * Resolve once every write that was issued before this call has been
	 * committed to disk. Used by readers that need read-after-write consistency
	 * (e.g. epic-finished detection) without having to thread the save promise
	 * through every caller of the fire-and-forget `persistWorkflow`.
	 */
	async waitForPendingWrites(): Promise<void> {
		const pending = Array.from(this.writeLocks.values());
		await Promise.all(pending);
	}

	/** Serialize writes per workflow ID so concurrent saves don't race. */
	private async withWriteLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.writeLocks.get(id) ?? Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.writeLocks.set(id, promise);
		try {
			await prev;
			return await fn();
		} finally {
			resolve();
			// Clean up lock entry if nothing else is queued
			if (this.writeLocks.get(id) === promise) {
				this.writeLocks.delete(id);
			}
		}
	}

	async load(id: string): Promise<Workflow | null> {
		const filePath = this.workflowPath(id);
		try {
			const content = await Bun.file(filePath).text();
			const data = JSON.parse(content);
			if (!data.id || !Array.isArray(data.steps) || !data.status) {
				logger.warn(`[workflow-store] Invalid workflow structure for ${id}`);
				return null;
			}
			if (
				typeof data.currentStepIndex !== "number" ||
				data.currentStepIndex < 0 ||
				data.currentStepIndex >= data.steps.length
			) {
				logger.warn(`[workflow-store] Invalid currentStepIndex for ${id}`);
				return null;
			}
			// Migration: backfill mergeCycle for pre-merge-pr workflows
			if (!data.mergeCycle) {
				data.mergeCycle = { attempt: 0, maxAttempts: 3 };
			}
			// Migration: rename the terminal status "cancelled" → "aborted" (the
			// wire protocol and UI now call this "Abort"/"Aborted" throughout).
			// Workflows persisted before the rename show up on disk with the old
			// name; normalise on load so downstream code only ever sees "aborted".
			if (data.status === "cancelled") data.status = "aborted";
			// Migration: same rename for in-flight feedback outcomes.
			if (Array.isArray(data.feedbackEntries)) {
				for (const entry of data.feedbackEntries) {
					if (entry?.outcome?.value === "cancelled") {
						entry.outcome.value = "aborted";
					}
				}
			}
			// Migration: backfill epic fields for pre-epic workflows
			if (data.epicId === undefined) data.epicId = null;
			if (data.epicTitle === undefined) data.epicTitle = null;
			if (!Array.isArray(data.epicDependencies)) data.epicDependencies = [];
			if (data.epicDependencyStatus === undefined) data.epicDependencyStatus = null;
			if (data.epicAnalysisMs === undefined) data.epicAnalysisMs = 0;
			// Migration: backfill feedbackEntries for pre-feedback workflows
			if (!Array.isArray(data.feedbackEntries)) data.feedbackEntries = [];
			if (data.feedbackPreRunHead === undefined) data.feedbackPreRunHead = null;
			if (data.activeInvocation === undefined) data.activeInvocation = null;
			if (data.managedRepo === undefined) data.managedRepo = null;
			// Migration: backfill workflow-level error field for pre-reset workflows.
			if (data.error === undefined) data.error = null;
			// Migration: backfill per-step history for pre-history workflows
			for (const step of data.steps) {
				if (!Array.isArray(step.history)) step.history = [];
				// Migration: synthesize outputLog for pre-outputLog steps (text-only fallback)
				if (!Array.isArray(step.outputLog)) {
					step.outputLog = step.output ? [{ kind: "text", text: step.output }] : [];
				}
				for (const run of step.history) {
					if (!Array.isArray(run.outputLog)) {
						run.outputLog = run.output ? [{ kind: "text", text: run.output }] : [];
					}
				}
			}
			return data as Workflow;
		} catch {
			logger.warn(`[workflow-store] Failed to load workflow ${id}`);
			return null;
		}
	}

	async loadAll(): Promise<Workflow[]> {
		const index = await this.loadIndex();
		const workflows: Workflow[] = [];
		const validIds: string[] = [];

		for (const entry of index) {
			const workflow = await this.load(entry.id);
			if (workflow) {
				workflows.push(workflow);
				validIds.push(entry.id);
			}
		}

		// Prune invalid entries from index if any were skipped
		if (validIds.length < index.length) {
			const validSet = new Set(validIds);
			const prunedIndex = index.filter((e) => validSet.has(e.id));
			await atomicWrite(this.indexPath(), JSON.stringify(prunedIndex, null, 2));
		}

		return workflows.sort(
			(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
		);
	}

	async loadIndex(): Promise<WorkflowIndexEntry[]> {
		const indexFile = this.indexPath();
		try {
			const content = await Bun.file(indexFile).text();
			return JSON.parse(content) as WorkflowIndexEntry[];
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
				logger.warn("[workflow-store] Index corrupted, rebuilding:", err);
			}
			return this.rebuildIndex();
		}
	}

	async removeAll(): Promise<void> {
		if (!existsSync(this.baseDir)) return;
		const files = readdirSync(this.baseDir).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			try {
				unlinkSync(join(this.baseDir, file));
			} catch {
				// Already gone
			}
		}
	}

	async remove(id: string): Promise<void> {
		const filePath = this.workflowPath(id);
		try {
			unlinkSync(filePath);
		} catch {
			// File already gone
		}

		try {
			const index = await this.loadIndex();
			const updated = index.filter((e) => e.id !== id);
			this.ensureDir();
			await atomicWrite(this.indexPath(), JSON.stringify(updated, null, 2));
		} catch (err) {
			logger.warn("[workflow-store] Index update failed after remove:", err);
		}
	}

	private async updateIndex(workflow: Workflow): Promise<void> {
		await this.indexLock.run(async () => {
			let index: WorkflowIndexEntry[];
			try {
				const content = await Bun.file(this.indexPath()).text();
				index = JSON.parse(content) as WorkflowIndexEntry[];
			} catch (err) {
				if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
					logger.warn("[workflow-store] Failed to parse index, starting fresh:", err);
				}
				index = [];
			}

			const entry: WorkflowIndexEntry = {
				id: workflow.id,
				branch: workflow.worktreeBranch,
				status: workflow.status,
				summary: workflow.summary,
				epicId: workflow.epicId,
				createdAt: workflow.createdAt,
				updatedAt: workflow.updatedAt,
			};

			const existingIdx = index.findIndex((e) => e.id === workflow.id);
			if (existingIdx >= 0) {
				index[existingIdx] = entry;
			} else {
				index.push(entry);
			}

			await atomicWrite(this.indexPath(), JSON.stringify(index, null, 2));
		});
	}

	private async rebuildIndex(): Promise<WorkflowIndexEntry[]> {
		const index: WorkflowIndexEntry[] = [];

		if (existsSync(this.baseDir)) {
			const files = readdirSync(this.baseDir).filter(
				(f) => f.endsWith(".json") && f !== "index.json",
			);

			for (const file of files) {
				const id = file.replace(/\.json$/, "");
				const workflow = await this.load(id);
				if (workflow) {
					index.push({
						id: workflow.id,
						branch: workflow.worktreeBranch,
						status: workflow.status,
						summary: workflow.summary,
						epicId: workflow.epicId,
						createdAt: workflow.createdAt,
						updatedAt: workflow.updatedAt,
					});
				}
			}
		}

		this.ensureDir();
		await atomicWrite(this.indexPath(), JSON.stringify(index, null, 2));

		return index;
	}
}
