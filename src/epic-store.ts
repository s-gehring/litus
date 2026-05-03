import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AsyncLock } from "./async-lock";
import { atomicWrite } from "./atomic-write";
import { workflowsDir } from "./litus-paths";
import { logger } from "./logger";
import type { PersistedEpic } from "./types";

function normalizePersistedEpic(data: Partial<PersistedEpic>): PersistedEpic {
	return {
		...(data as PersistedEpic),
		decompositionSessionId: data.decompositionSessionId ?? null,
		feedbackHistory: Array.isArray(data.feedbackHistory) ? data.feedbackHistory : [],
		sessionContextLost: data.sessionContextLost === true,
		attemptCount: typeof data.attemptCount === "number" ? data.attemptCount : 1,
		archived: typeof data.archived === "boolean" ? data.archived : false,
		archivedAt: data.archivedAt ?? null,
	};
}

export class EpicStore {
	private baseDir: string;
	private writeLock = new AsyncLock();

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? workflowsDir();
	}

	private ensureDir(): void {
		mkdirSync(this.baseDir, { recursive: true });
	}

	private filePath(): string {
		return join(this.baseDir, "epics.json");
	}

	async loadAll(): Promise<PersistedEpic[]> {
		try {
			const file = Bun.file(this.filePath());
			if (!(await file.exists())) return [];
			const data = await file.json();
			if (!Array.isArray(data)) return [];
			return (data as Partial<PersistedEpic>[]).map(normalizePersistedEpic);
		} catch (err) {
			logger.warn("[epic-store] Failed to load epics:", err);
			return [];
		}
	}

	async removeAll(): Promise<void> {
		const fp = this.filePath();
		if (existsSync(fp)) {
			try {
				unlinkSync(fp);
			} catch {
				// Already gone
			}
		}
	}

	async dropAnalyzing(): Promise<number> {
		return await this.writeLock.run(async () => {
			const all = await this.loadAll();
			const kept = all.filter((e) => e.status !== "analyzing");
			const dropped = all.length - kept.length;
			if (dropped === 0) return 0;
			this.ensureDir();
			await atomicWrite(this.filePath(), JSON.stringify(kept, null, 2));
			return dropped;
		});
	}

	async save(epic: PersistedEpic): Promise<void> {
		await this.writeLock.run(async () => {
			this.ensureDir();
			const all = await this.loadAll();
			const idx = all.findIndex((e) => e.epicId === epic.epicId);
			if (idx >= 0) {
				all[idx] = epic;
			} else {
				all.push(epic);
			}
			await atomicWrite(this.filePath(), JSON.stringify(all, null, 2));
		});
	}
}
