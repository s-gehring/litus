import { homedir } from "node:os";
import { join } from "node:path";
import { AsyncLock } from "./async-lock";
import { atomicWrite } from "./atomic-write";
import { logger } from "./logger";
import type { Alert, AlertType } from "./types";

const SCHEMA_VERSION = 1;

const ALERT_TYPES: ReadonlySet<string> = new Set<AlertType>([
	"question-asked",
	"pr-opened-manual",
	"workflow-finished",
	"epic-finished",
	"error",
]);

interface PersistedFile {
	version: number;
	alerts: unknown[];
}

function isValidAlert(v: unknown): v is Alert {
	if (!v || typeof v !== "object") return false;
	const a = v as Record<string, unknown>;
	return (
		typeof a.id === "string" &&
		typeof a.type === "string" &&
		ALERT_TYPES.has(a.type) &&
		typeof a.title === "string" &&
		typeof a.description === "string" &&
		(a.workflowId === null || typeof a.workflowId === "string") &&
		(a.epicId === null || typeof a.epicId === "string") &&
		typeof a.targetRoute === "string" &&
		typeof a.createdAt === "number" &&
		Number.isFinite(a.createdAt) &&
		a.createdAt > 0
	);
}

export class AlertStore {
	private baseDir: string;
	private writeLock = new AsyncLock();

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".litus", "alerts");
	}

	private filePath(): string {
		return join(this.baseDir, "alerts.json");
	}

	async load(): Promise<Alert[]> {
		try {
			const file = Bun.file(this.filePath());
			if (!(await file.exists())) return [];
			const data = (await file.json()) as PersistedFile | unknown[];
			// Legacy / wrong format: treat as empty
			if (Array.isArray(data)) {
				logger.warn("[alert-store] Legacy array format detected; starting fresh");
				return [];
			}
			if (!data || typeof data !== "object") return [];
			if (data.version !== SCHEMA_VERSION) {
				logger.warn(
					`[alert-store] Unknown schema version ${data.version}; starting fresh`,
				);
				return [];
			}
			if (!Array.isArray(data.alerts)) return [];
			const out: Alert[] = [];
			for (const entry of data.alerts) {
				if (isValidAlert(entry)) {
					out.push(entry);
				} else {
					logger.warn("[alert-store] Dropping invalid alert entry");
				}
			}
			return out;
		} catch (err) {
			logger.warn("[alert-store] Failed to load alerts:", err);
			return [];
		}
	}

	async save(alerts: Alert[]): Promise<void> {
		await this.writeLock.run(async () => {
			const payload: PersistedFile = { version: SCHEMA_VERSION, alerts };
			await atomicWrite(this.filePath(), JSON.stringify(payload, null, 2));
		});
	}
}
