import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AsyncLock } from "./async-lock";
import { atomicWrite } from "./atomic-write";
import type { PersistedEpic } from "./types";

export class EpicStore {
	private baseDir: string;
	private writeLock = new AsyncLock();

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".litus", "workflows");
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
			return data as PersistedEpic[];
		} catch {
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
