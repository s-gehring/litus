import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../src/audit-logger";
import type { AuditEvent } from "../src/types";

const TEST_DIR = join(tmpdir(), "litus-audit-integration-test");

function readEvents(pipelineName: string): AuditEvent[] {
	const filePath = join(TEST_DIR, `${pipelineName}.jsonl`);
	const content = readFileSync(filePath, "utf-8").trim();
	return content.split("\n").map((line) => JSON.parse(line));
}

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

// T029 — E2E integration test
describe("E2E audit trail", () => {
	it("produces complete JSONL output with all event types, correct sequences, and valid JSON", () => {
		const logger = new AuditLogger({ auditDir: TEST_DIR });
		const pipelineName = "integration-test-pipeline";
		const runId = logger.startRun(pipelineName, "feature-branch");

		// Simulate a pipeline run
		logger.logQuery(runId, "What is the feature description?", "specify");
		logger.logAnswer(runId, "I want to add audit trail logging", "specify");
		logger.logQuery(runId, "Any constraints?", "clarify");
		logger.logAnswer(runId, "Must be non-blocking", "clarify");
		logger.logCommit(runId, "abc1234", "feat: add audit logger", "implement");
		logger.logCommit(runId, "def5678", "chore: add tests", "implement");
		logger.endRun(runId, { totalSteps: 8, reviewIterations: 1 });

		const events = readEvents(pipelineName);

		// All events are valid JSON (parsing didn't throw)
		expect(events).toHaveLength(8);

		// Correct event types in order
		const types = events.map((e) => e.eventType);
		expect(types).toEqual([
			"pipeline_start",
			"query",
			"answer",
			"query",
			"answer",
			"commit",
			"commit",
			"pipeline_end",
		]);

		// Sequence numbers are monotonically increasing
		for (let i = 0; i < events.length; i++) {
			expect(events[i].sequenceNumber).toBe(i);
		}

		// All events share the same runId
		for (const event of events) {
			expect(event.runId).toBe(runId);
		}

		// All events have the pipeline name
		for (const event of events) {
			expect(event.pipelineName).toBe(pipelineName);
		}

		// Branch is populated
		for (const event of events) {
			expect(event.branch).toBe("feature-branch");
		}

		// Timestamps are valid ISO 8601
		for (const event of events) {
			expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
		}

		// Commit events have hashes
		const commits = events.filter((e) => e.eventType === "commit");
		expect(commits[0].commitHash).toBe("abc1234");
		expect(commits[1].commitHash).toBe("def5678");

		// End event has metadata
		const endEvent = events[events.length - 1];
		expect(endEvent.metadata).toEqual({ totalSteps: 8, reviewIterations: 1 });
	});
});
