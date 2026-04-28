import { join } from "node:path";
import { AsyncLock } from "./async-lock";
import { atomicWrite } from "./atomic-write";
import { alertsDir } from "./litus-paths";
import { logger } from "./logger";
import type { Alert, AlertType } from "./types";

const SCHEMA_VERSION = 2;
const SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

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

function coerceAlert(v: unknown, version: number): Alert | null {
	if (!v || typeof v !== "object") return null;
	const a = v as Record<string, unknown>;
	const baseValid =
		typeof a.id === "string" &&
		typeof a.type === "string" &&
		ALERT_TYPES.has(a.type as string) &&
		typeof a.title === "string" &&
		typeof a.description === "string" &&
		(a.workflowId === null || typeof a.workflowId === "string") &&
		(a.epicId === null || typeof a.epicId === "string") &&
		typeof a.targetRoute === "string" &&
		typeof a.createdAt === "number" &&
		Number.isFinite(a.createdAt) &&
		(a.createdAt as number) > 0;
	if (!baseValid) return null;
	// v1 → v2 migration: pre-existing alerts default to seen=true (FR-015).
	const seen = typeof a.seen === "boolean" ? a.seen : version < 2 ? true : null;
	if (seen === null) return null;
	return {
		id: a.id as string,
		type: a.type as AlertType,
		title: a.title as string,
		description: a.description as string,
		workflowId: a.workflowId as string | null,
		epicId: a.epicId as string | null,
		targetRoute: a.targetRoute as string,
		createdAt: a.createdAt as number,
		seen,
	};
}

export class AlertStore {
	private baseDir: string;
	private writeLock = new AsyncLock();

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? alertsDir();
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
			const version =
				typeof data.version === "number" && Number.isFinite(data.version) ? data.version : 1;
			if (!SUPPORTED_VERSIONS.has(version)) {
				logger.warn(`[alert-store] Unknown schema version ${data.version}; starting fresh`);
				return [];
			}
			if (!Array.isArray(data.alerts)) return [];
			const out: Alert[] = [];
			for (const entry of data.alerts) {
				const coerced = coerceAlert(entry, version);
				if (coerced) {
					out.push(coerced);
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
