import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PersistedEpic } from "./types";

export class EpicStore {
	private baseDir: string;
	private writeLock: Promise<void> = Promise.resolve();

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
		await this.withWriteLock(async () => {
			this.ensureDir();
			const all = await this.loadAll();
			const idx = all.findIndex((e) => e.epicId === epic.epicId);
			if (idx >= 0) {
				all[idx] = epic;
			} else {
				all.push(epic);
			}
			await this.atomicWrite(this.filePath(), JSON.stringify(all, null, 2));
		});
	}

	private async atomicWrite(filePath: string, data: string): Promise<void> {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const tmpPath = `${filePath}.${suffix}.tmp`;
		await Bun.write(tmpPath, data);

		for (let attempt = 0; ; attempt++) {
			try {
				renameSync(tmpPath, filePath);
				return;
			} catch (err) {
				if (attempt >= 3) {
					try {
						unlinkSync(tmpPath);
					} catch {
						/* tmp cleanup */
					}
					await Bun.write(filePath, data);
					return;
				}
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "EPERM" || code === "EACCES") {
					await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
					continue;
				}
				throw err;
			}
		}
	}

	private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.writeLock;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.writeLock = promise;
		try {
			await prev;
			return await fn();
		} finally {
			resolve();
		}
	}
}
