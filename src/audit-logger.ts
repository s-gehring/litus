import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger";
import type { AuditConfig, AuditEvent, AuditEventType, WorkflowResetAuditEvent } from "./types";

const DEFAULT_AUDIT_DIR = join(homedir(), ".litus", "audit");

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
			logger.warn(`[audit] Failed to create audit directory: ${err}`);
		}
	}

	removeAll(): void {
		try {
			const files = readdirSync(this.auditDir).filter((f) => f.endsWith(".jsonl"));
			for (const file of files) {
				try {
					unlinkSync(join(this.auditDir, file));
				} catch (err) {
					logger.warn(`[audit] Failed to remove audit file ${file}:`, err);
				}
			}
		} catch (err) {
			logger.warn("[audit] Failed to list audit directory:", err);
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
		this.logSimple(runId, "query", content, stepName);
	}

	logAnswer(runId: string, content: string, stepName: string | null): void {
		this.logSimple(runId, "answer", content, stepName);
	}

	private logSimple(
		runId: string,
		eventType: AuditEventType,
		content: string,
		stepName: string | null,
	): void {
		this.writeEvent(runId, { eventType, content, stepName, commitHash: null, metadata: null });
	}

	// Artifacts-step lifecycle events. `start` captures what the run was
	// configured with; `end` captures the outcome, every file the step kept, and
	// any rejection reasons (manifest/cap/timeout/LLM error). Matches FR-015.
	logArtifactsStart(
		runId: string,
		payload: {
			workflowId: string;
			model: string;
			effort: string | null;
		},
	): void {
		this.writeEvent(runId, {
			eventType: "artifacts.step.start",
			content: null,
			stepName: "artifacts",
			commitHash: null,
			metadata: {
				workflowId: payload.workflowId,
				model: payload.model,
				effort: payload.effort,
			},
		});
	}

	logArtifactsEnd(
		runId: string,
		payload: {
			workflowId: string;
			outcome: "with-files" | "empty" | "error";
			reason?: string;
			files?: Array<{ relPath: string; sizeBytes: number }>;
			rejections?: Array<{ relPath: string; reason: string }>;
			caps?: { perFileMaxBytes: number; perStepMaxBytes: number };
			timeoutMs?: number;
		},
	): void {
		this.writeEvent(runId, {
			eventType: "artifacts.step.end",
			content: payload.reason ?? null,
			stepName: "artifacts",
			commitHash: null,
			metadata: {
				workflowId: payload.workflowId,
				outcome: payload.outcome,
				files: payload.files ?? [],
				rejections: payload.rejections ?? [],
				caps: payload.caps ?? null,
				timeoutMs: payload.timeoutMs ?? null,
			},
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

	/**
	 * Append a `workflow.reset` audit line to the pipeline-scoped JSONL file.
	 * Standalone event — not tied to an in-flight run (no runId/sequence), so it
	 * bypasses `writeEvent`. Matches contracts/audit-workflow-reset.md.
	 */
	logWorkflowReset(params: {
		pipelineName: string;
		workflowId: string;
		epicId: string | null;
		branch: string;
		worktreePath: string;
		artifactCount: number;
		partialFailure: boolean;
	}): void {
		try {
			const safeFileName = params.pipelineName.replace(/[/\\:*?"<>|]+/g, "--");
			const event: WorkflowResetAuditEvent = {
				type: "workflow.reset",
				timestamp: new Date().toISOString(),
				actor: "local",
				workflowId: params.workflowId,
				epicId: params.epicId,
				branch: params.branch,
				worktreePath: params.worktreePath,
				artifactCount: params.artifactCount,
				partialFailure: params.partialFailure,
			};
			const filePath = join(this.auditDir, `${safeFileName}.jsonl`);
			appendFileSync(filePath, `${JSON.stringify(event)}\n`);
		} catch (err) {
			logger.warn(`[audit] Failed to write workflow.reset event: ${err}`);
		}
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
				logger.warn(`[audit] Unknown runId: ${runId} — event dropped`);
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
			logger.warn(`[audit] Failed to write event: ${err}`);
		}
	}
}
