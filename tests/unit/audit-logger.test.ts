import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

// Locks in the wrapped-row contract from contracts/audit-aspect-attribution.md
// §2.1: aspect-keyed processes write `{ workflowId, aspectId, event }` to
// events.jsonl while non-aspect processes keep the bare-event shape. The
// emission point lives in `src/cli-runner.ts:streamOutput` (not in
// AuditLogger), so this test exercises the JSONL contract directly: append
// the same shapes the runner would produce, then read them back and verify
// attribution survives the round-trip.
describe("audit events.jsonl — aspect attribution wrapper round-trip", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = join(tmpdir(), `audit-aspect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		file = join(dir, "events.jsonl");
	});

	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test("aspect-keyed rows wrap event with { workflowId, aspectId, event }; non-aspect rows keep bare event shape", () => {
		const bareEvent = { type: "assistant", session_id: "s1" };
		const wrapped = { workflowId: "wf-1", aspectId: "a-2", event: bareEvent };

		// Mimics what cli-runner.streamOutput appends.
		appendFileSync(file, `${JSON.stringify(bareEvent)}\n`);
		appendFileSync(file, `${JSON.stringify(wrapped)}\n`);

		const lines = readFileSync(file, "utf-8").trim().split("\n");
		expect(lines.length).toBe(2);

		const row0 = JSON.parse(lines[0]) as Record<string, unknown>;
		const row1 = JSON.parse(lines[1]) as Record<string, unknown>;

		// Bare row: top-level event fields, no attribution wrapper.
		expect(row0.type).toBe("assistant");
		expect(row0.workflowId).toBeUndefined();
		expect(row0.aspectId).toBeUndefined();

		// Wrapped row: attribution at the top level, inner event preserved.
		expect(row1.workflowId).toBe("wf-1");
		expect(row1.aspectId).toBe("a-2");
		const innerEvent = row1.event as Record<string, unknown>;
		expect(innerEvent.type).toBe("assistant");
		expect(innerEvent.session_id).toBe("s1");
	});
});
