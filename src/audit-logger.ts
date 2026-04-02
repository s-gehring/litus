import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuditConfig, AuditEvent, AuditEventType } from "./types";

const DEFAULT_AUDIT_DIR = join(homedir(), ".crab-studio", "audit");

interface RunState {
	pipelineName: string;
	safeFileName: string;
	branch: string | null;
	sequence: number;
}

export class AuditLogger {
	readonly auditDir: string;
	private runs: Map<string, RunState> = new Map();

	constructor(config?: AuditConfig) {
		this.auditDir = config?.auditDir ?? DEFAULT_AUDIT_DIR;
		try {
			mkdirSync(this.auditDir, { recursive: true });
		} catch (err) {
			console.warn(`[audit] Failed to create audit directory: ${err}`);
		}
	}

	startRun(pipelineName: string, branch: string | null): string {
		const runId = crypto.randomUUID();
		const safeFileName = pipelineName.replace(/[/\\:*?"<>|]+/g, "--");
		this.runs.set(runId, { pipelineName, safeFileName, branch, sequence: 0 });
		this.writeEvent(runId, {
			eventType: "pipeline_start",
			content: null,
			stepName: null,
			commitHash: null,
			metadata: { featureBranch: branch },
		});
		return runId;
	}

	endRun(runId: string, metadata?: Record<string, unknown>): void {
		const hadRun = this.runs.has(runId);
		this.writeEvent(runId, {
			eventType: "pipeline_end",
			content: null,
			stepName: null,
			commitHash: null,
			metadata: metadata ?? null,
		});
		if (hadRun) {
			this.runs.delete(runId);
		}
	}

	logQuery(runId: string, content: string, stepName: string | null): void {
		this.writeEvent(runId, {
			eventType: "query",
			content,
			stepName,
			commitHash: null,
			metadata: null,
		});
	}

	logAnswer(runId: string, content: string, stepName: string | null): void {
		this.writeEvent(runId, {
			eventType: "answer",
			content,
			stepName,
			commitHash: null,
			metadata: null,
		});
	}

	// Note: logCommit is not yet wired into the pipeline — requires commit detection in CLI output (deferred)
	logCommit(
		runId: string,
		commitHash: string,
		message: string | null,
		stepName: string | null,
	): void {
		this.writeEvent(runId, {
			eventType: "commit",
			content: message,
			stepName,
			commitHash,
			metadata: null,
		});
	}

	private writeEvent(
		runId: string,
		fields: {
			eventType: AuditEventType;
			content: string | null;
			stepName: string | null;
			commitHash: string | null;
			metadata: Record<string, unknown> | null;
		},
	): void {
		try {
			const run = this.runs.get(runId);
			if (!run) {
				console.warn(`[audit] Unknown runId: ${runId} — event dropped`);
				return;
			}

			const seq = run.sequence;
			run.sequence = seq + 1;

			const event: AuditEvent = {
				timestamp: new Date().toISOString(),
				eventType: fields.eventType,
				runId,
				pipelineName: run.pipelineName,
				branch: run.branch,
				commitHash: fields.commitHash,
				stepName: fields.stepName,
				sequenceNumber: seq,
				content: fields.content,
				metadata: fields.metadata,
			};

			const filePath = join(this.auditDir, `${run.safeFileName}.jsonl`);
			appendFileSync(filePath, `${JSON.stringify(event)}\n`);
		} catch (err) {
			console.warn(`[audit] Failed to write event: ${err}`);
		}
	}
}
