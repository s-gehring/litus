import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../src/audit-logger";

describe("AuditLogger.logWorkflowReset", () => {
	let dir: string;
	let logger: AuditLogger;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "litus-audit-"));
		logger = new AuditLogger({ auditDir: dir });
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	test("writes a workflow.reset line with the exact contract fields", () => {
		logger.logWorkflowReset({
			pipelineName: "my-pipeline",
			workflowId: "wf_abc",
			epicId: "epic_42",
			branch: "tmp-abc12345",
			worktreePath: "/tmp/worktrees/tmp-abc12345",
			artifactCount: 7,
			partialFailure: false,
		});

		const filePath = join(dir, "my-pipeline.jsonl");
		expect(existsSync(filePath)).toBe(true);
		const line = readFileSync(filePath, "utf8").trim();
		const event = JSON.parse(line);
		expect(event.type).toBe("workflow.reset");
		expect(event.workflowId).toBe("wf_abc");
		expect(event.epicId).toBe("epic_42");
		expect(event.branch).toBe("tmp-abc12345");
		expect(event.worktreePath).toBe("/tmp/worktrees/tmp-abc12345");
		expect(event.artifactCount).toBe(7);
		expect(event.partialFailure).toBe(false);
		expect(event.actor).toBe("local");
		expect(typeof event.timestamp).toBe("string");
	});

	test("sanitizes pipeline name for filename", () => {
		logger.logWorkflowReset({
			pipelineName: "feat/with:bad*chars",
			workflowId: "wf_1",
			epicId: null,
			branch: "",
			worktreePath: "",
			artifactCount: 0,
			partialFailure: true,
		});
		const filePath = join(dir, "feat--with--bad--chars.jsonl");
		expect(existsSync(filePath)).toBe(true);
	});
});
