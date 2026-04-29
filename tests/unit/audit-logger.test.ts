import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit-logger";

describe("AuditLogger.logFeedbackSubmittedResume", () => {
	let auditDir: string;
	let logger: AuditLogger;

	beforeEach(() => {
		auditDir = join(
			tmpdir(),
			`audit-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(auditDir, { recursive: true });
		logger = new AuditLogger({ auditDir });
	});

	afterEach(() => {
		try {
			rmSync(auditDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	function readEvents(): Record<string, unknown>[] {
		const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
		expect(files.length).toBeGreaterThan(0);
		const lines = readFileSync(join(auditDir, files[0]), "utf-8").trim().split("\n");
		return lines.map((l) => JSON.parse(l));
	}

	test("emits an event with eventType=feedback_submitted_resume, content=null, and metadata containing only stepIndex + feedbackLengthChars (FR-015)", () => {
		const runId = logger.startRun("test-pipeline", "feature/branch");
		logger.logFeedbackSubmittedResume(runId, "implement", 4, 42);

		const events = readEvents();
		const target = events.find((e) => e.eventType === "feedback_submitted_resume");
		expect(target).toBeDefined();
		if (!target) return;
		expect(target.eventType).toBe("feedback_submitted_resume");
		expect(target.content).toBeNull();
		expect(target.commitHash).toBeNull();
		expect(target.stepName).toBe("implement");
		expect(target.runId).toBe(runId);
		expect(target.pipelineName).toBe("test-pipeline");
		expect(target.branch).toBe("feature/branch");
		expect(typeof target.timestamp).toBe("string");
		expect(typeof target.sequenceNumber).toBe("number");
		const metadata = target.metadata as Record<string, unknown>;
		expect(metadata).toEqual({ stepIndex: 4, feedbackLengthChars: 42 });
	});

	test("emits a fresh per-run sequenceNumber after pipeline_start", () => {
		const runId = logger.startRun("seq-pipeline", null);
		logger.logFeedbackSubmittedResume(runId, "implement", 0, 10);

		const events = readEvents();
		expect(events[0].eventType).toBe("pipeline_start");
		const target = events.find((e) => e.eventType === "feedback_submitted_resume");
		expect(target).toBeDefined();
		if (!target) return;
		expect(target.sequenceNumber).toBe(1);
	});
});
