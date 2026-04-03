import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Workflow, WorkflowIndexEntry } from "./types";

export class WorkflowStore {
	private baseDir: string;
	private indexLock: Promise<void> = Promise.resolve();

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".crab-studio", "workflows");
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

	private async atomicWrite(filePath: string, data: string): Promise<void> {
		this.ensureDir();
		const tmpPath = `${filePath}.tmp`;
		await Bun.write(tmpPath, data);
		renameSync(tmpPath, filePath);
	}

	async save(workflow: Workflow): Promise<void> {
		this.ensureDir();

		const data = JSON.stringify(workflow, null, 2);
		await this.atomicWrite(this.workflowPath(workflow.id), data);

		await this.updateIndex(workflow);
	}

	async load(id: string): Promise<Workflow | null> {
		const filePath = this.workflowPath(id);
		try {
			const content = await Bun.file(filePath).text();
			const data = JSON.parse(content);
			if (!data.id || !Array.isArray(data.steps) || !data.status) {
				console.warn(`[workflow-store] Invalid workflow structure for ${id}`);
				return null;
			}
			if (
				typeof data.currentStepIndex !== "number" ||
				data.currentStepIndex < 0 ||
				data.currentStepIndex >= data.steps.length
			) {
				console.warn(`[workflow-store] Invalid currentStepIndex for ${id}`);
				return null;
			}
			return data as Workflow;
		} catch {
			console.warn(`[workflow-store] Failed to load workflow ${id}`);
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
			await this.atomicWrite(this.indexPath(), JSON.stringify(prunedIndex, null, 2));
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
		} catch {
			// Index missing or corrupted — rebuild from directory scan
			return this.rebuildIndex();
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
			await this.atomicWrite(this.indexPath(), JSON.stringify(updated, null, 2));
		} catch {
			// Index update failed — non-critical
		}
	}

	private async updateIndex(workflow: Workflow): Promise<void> {
		await this.withIndexLock(async () => {
			let index: WorkflowIndexEntry[];
			try {
				const content = await Bun.file(this.indexPath()).text();
				index = JSON.parse(content) as WorkflowIndexEntry[];
			} catch {
				index = [];
			}

			const entry: WorkflowIndexEntry = {
				id: workflow.id,
				branch: workflow.worktreeBranch,
				status: workflow.status,
				summary: workflow.summary,
				createdAt: workflow.createdAt,
				updatedAt: workflow.updatedAt,
			};

			const existingIdx = index.findIndex((e) => e.id === workflow.id);
			if (existingIdx >= 0) {
				index[existingIdx] = entry;
			} else {
				index.push(entry);
			}

			await this.atomicWrite(this.indexPath(), JSON.stringify(index, null, 2));
		});
	}

	private async withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.indexLock;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.indexLock = promise;
		try {
			await prev;
			return await fn();
		} finally {
			resolve();
		}
	}

	private async rebuildIndex(): Promise<WorkflowIndexEntry[]> {
		if (!existsSync(this.baseDir)) return [];

		const files = readdirSync(this.baseDir).filter(
			(f) => f.endsWith(".json") && f !== "index.json",
		);
		const index: WorkflowIndexEntry[] = [];

		for (const file of files) {
			const id = file.replace(/\.json$/, "");
			const workflow = await this.load(id);
			if (workflow) {
				index.push({
					id: workflow.id,
					branch: workflow.worktreeBranch,
					status: workflow.status,
					summary: workflow.summary,
					createdAt: workflow.createdAt,
					updatedAt: workflow.updatedAt,
				});
			}
		}

		if (index.length > 0) {
			this.ensureDir();
			await this.atomicWrite(this.indexPath(), JSON.stringify(index, null, 2));
		}

		return index;
	}
}
