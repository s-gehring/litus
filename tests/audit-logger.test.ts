import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../src/audit-logger";
import type { AuditEvent } from "../src/types";

const TEST_AUDIT_DIR = join(tmpdir(), "litus-audit-test");

function readEvents(pipelineName: string): AuditEvent[] {
	const filePath = join(TEST_AUDIT_DIR, `${pipelineName}.jsonl`);
	const content = readFileSync(filePath, "utf-8").trim();
	return content.split("\n").map((line) => JSON.parse(line));
}

afterEach(() => {
	rmSync(TEST_AUDIT_DIR, { recursive: true, force: true });
});

// T007 — US1: logQuery writes correct JSONL
describe("logQuery", () => {
	it("appends a query event with correct fields", () => {
		const logger = new AuditLogger({ auditDir: TEST_AUDIT_DIR });
		const runId = logger.startRun("test-pipeline", "main");
		logger.logQuery(runId, "What is the feature?", "specify");

		const events = readEvents("test-pipeline");
		const queryEvent = events.find((e) => e.eventType === "query") as AuditEvent;
		expect(queryEvent).toBeDefined();
		expect(queryEvent.eventType).toBe("query");
		expect(queryEvent.content).toBe("What is the feature?");
		expect(queryEvent.stepName).toBe("specify");
		expect(queryEvent.runId).toBe(runId);
		expect(queryEvent.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(queryEvent.sequenceNumber).toBeGreaterThan(0);
	});
});

// T008 — US1: logAnswer writes correct JSONL
describe("logAnswer", () => {
	it("appends an answer event with correct fields", () => {
		const logger = new AuditLogger({ auditDir: TEST_AUDIT_DIR });
		const runId = logger.startRun("test-pipeline", "main");
		logger.logAnswer(runId, "I want audit logging", "specify");

		const events = readEvents("test-pipeline");
		const answerEvent = events.find((e) => e.eventType === "answer") as AuditEvent;
		expect(answerEvent).toBeDefined();
		expect(answerEvent.eventType).toBe("answer");
		expect(answerEvent.content).toBe("I want audit logging");
		expect(answerEvent.stepName).toBe("specify");
		expect(answerEvent.sequenceNumber).toBeGreaterThan(0);
	});
});

// T009 — US1: startRun/endRun lifecycle
describe("startRun/endRun lifecycle", () => {
	it("writes pipeline_start and pipeline_end events with correct runId and sequence", () => {
		const logger = new AuditLogger({ auditDir: TEST_AUDIT_DIR });
		const runId = logger.startRun("test-pipeline", "main");
		logger.endRun(runId, { totalSteps: 5 });

		const events = readEvents("test-pipeline");
		expect(events).toHaveLength(2);

		const start = events[0];
		expect(start.eventType).toBe("pipeline_start");
		expect(start.runId).toBe(runId);
		expect(start.sequenceNumber).toBe(0);

		const end = events[1];
		expect(end.eventType).toBe("pipeline_end");
		expect(end.runId).toBe(runId);
		expect(end.sequenceNumber).toBe(1);
		expect(end.metadata).toEqual({ totalSteps: 5 });
	});
});

// T015 — US2: branch field is populated
describe("git branch tracking", () => {
	it("populates branch field in all events", () => {
		const logger = new AuditLogger({ auditDir: TEST_AUDIT_DIR });
		const runId = logger.startRun("test-pipeline", "feature-branch");
		logger.logQuery(runId, "test", null);
		logger.endRun(runId);

		const events = readEvents("test-pipeline");
		for (const event of events) {
			expect(event.branch).toBe("feature-branch");
		}
	});
});

// T016 — US2: logCommit writes correct JSONL
describe("logCommit", () => {
	it("writes a commit event with commitHash and message", () => {
		const logger = new AuditLogger({ auditDir: TEST_AUDIT_DIR });
		const runId = logger.startRun("test-pipeline", "main");
		logger.logCommit(runId, "abc1234", "feat: add audit", "implement");

		const events = readEvents("test-pipeline");
		const commitEvent = events.find((e) => e.eventType === "commit") as AuditEvent;
		expect(commitEvent).toBeDefined();
		expect(commitEvent.commitHash).toBe("abc1234");
		expect(commitEvent.content).toBe("feat: add audit");
		expect(commitEvent.stepName).toBe("implement");
	});
});

// T021 — US4: default audit directory path
describe("default audit directory", () => {
	it("resolves to $HOME/.litus/audit by default", () => {
		const logger = new AuditLogger();
		const expectedDefault = join(homedir(), ".litus", "audit");
		expect(logger.auditDir).toBe(expectedDefault);
	});
});

// T022 — US4: custom auditDir config
describe("custom auditDir config", () => {
	it("respects AuditConfig.auditDir override and writes to the specified directory", () => {
		const customDir = join(tmpdir(), "litus-audit-test-custom");
		const logger = new AuditLogger({ auditDir: customDir });
		expect(logger.auditDir).toBe(customDir);

		const runId = logger.startRun("custom-dir-test", null);
		logger.endRun(runId);

		const filePath = join(customDir, "custom-dir-test.jsonl");
		const content = readFileSync(filePath, "utf-8").trim();
		expect(content.split("\n")).toHaveLength(2);

		// Verify default dir was NOT used
		const defaultFile = join(homedir(), ".litus", "audit", "custom-dir-test.jsonl");
		expect(() => readFileSync(defaultFile)).toThrow();

		rmSync(customDir, { recursive: true, force: true });
	});
});

// T025 — US3: file naming
describe("file naming", () => {
	it("creates file as {pipelineName}.jsonl in audit directory", () => {
		const logger = new AuditLogger({ auditDir: TEST_AUDIT_DIR });
		const runId = logger.startRun("my-pipeline", null);
		logger.endRun(runId);

		const filePath = join(TEST_AUDIT_DIR, "my-pipeline.jsonl");
		const content = readFileSync(filePath, "utf-8");
		expect(content.trim().split("\n")).toHaveLength(2);
	});
});

// Pipeline name sanitization (review issue #5)
describe("pipeline name sanitization", () => {
	it("replaces path separators in pipeline name for filesystem safety", () => {
		const logger = new AuditLogger({ auditDir: TEST_AUDIT_DIR });
		const runId = logger.startRun("litus/test", "main");
		logger.endRun(runId);

		const filePath = join(TEST_AUDIT_DIR, "litus--test.jsonl");
		const content = readFileSync(filePath, "utf-8").trim();
		const events: AuditEvent[] = content.split("\n").map((line) => JSON.parse(line));
		expect(events).toHaveLength(2);
		expect(events[0].pipelineName).toBe("litus/test");
	});
});

// T026 — US3: append behavior
describe("append behavior", () => {
	it("appends to existing file on second run", () => {
		const logger = new AuditLogger({ auditDir: TEST_AUDIT_DIR });

		const run1 = logger.startRun("append-test", null);
		logger.endRun(run1);

		const run2 = logger.startRun("append-test", "main");
		logger.endRun(run2);

		const events = readEvents("append-test");
		expect(events).toHaveLength(4); // 2 events per run
		expect(events[0].runId).toBe(run1);
		expect(events[2].runId).toBe(run2);
	});
});

// T030 — non-blocking error handling
describe("non-blocking error handling", () => {
	it("emits console.warn but does not throw on write failure", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		// Use NUL device path — can't create directories under it
		const logger = new AuditLogger({ auditDir: "\0invalid" });
		const runId = logger.startRun("fail-test", null);
		// Should not throw
		logger.logQuery(runId, "test", null);
		logger.endRun(runId);
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

// T031 — missing git context
describe("missing git context", () => {
	it("logs events with null branch when not in a git repo", () => {
		const logger = new AuditLogger({ auditDir: TEST_AUDIT_DIR });
		const runId = logger.startRun("no-git-test", null);
		logger.logQuery(runId, "test query", "specify");
		logger.endRun(runId);

		const events = readEvents("no-git-test");
		for (const event of events) {
			expect(event.branch).toBeNull();
		}
	});
});

// Review #4, Issue #6 — double endRun is a no-op
describe("double endRun", () => {
	it("warns and drops the second endRun without throwing", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		const logger = new AuditLogger({ auditDir: TEST_AUDIT_DIR });
		const runId = logger.startRun("double-end-test", "main");
		logger.endRun(runId);
		logger.endRun(runId); // second call — run already deleted

		const events = readEvents("double-end-test");
		expect(events).toHaveLength(2); // only start + first end
		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining("Unknown runId"),
		);
		warnSpy.mockRestore();
	});
});

// Sequence number ordering
describe("sequence numbers", () => {
	it("increments monotonically within a run", () => {
		const logger = new AuditLogger({ auditDir: TEST_AUDIT_DIR });
		const runId = logger.startRun("seq-test", "main");
		logger.logQuery(runId, "q1", "step1");
		logger.logAnswer(runId, "a1", "step1");
		logger.logCommit(runId, "hash1", "msg", "step1");
		logger.endRun(runId);

		const events = readEvents("seq-test");
		for (let i = 0; i < events.length; i++) {
			expect(events[i].sequenceNumber).toBe(i);
		}
	});
});
