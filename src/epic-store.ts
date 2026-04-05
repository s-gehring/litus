import { mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PersistedEpic } from "./types";

export class EpicStore {
	private baseDir: string;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".crab-studio", "workflows");
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

	async save(epic: PersistedEpic): Promise<void> {
		this.ensureDir();
		const all = await this.loadAll();
		const idx = all.findIndex((e) => e.epicId === epic.epicId);
		if (idx >= 0) {
			all[idx] = epic;
		} else {
			all.push(epic);
		}
		const filePath = this.filePath();
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const tmpPath = `${filePath}.${suffix}.tmp`;
		await Bun.write(tmpPath, JSON.stringify(all, null, 2));
		renameSync(tmpPath, filePath);
	}
}
