import { describe, expect, test } from "bun:test";
import {
	buildFixImplementPrompt,
	FIX_IMPLEMENT_EMPTY_DIFF_MESSAGE,
	isEmptyDiff,
} from "../../src/fix-implementer";
import { WorkflowEngine } from "../../src/workflow-engine";

async function makeQuickFix(spec: string) {
	const engine = new WorkflowEngine();
	return engine.createWorkflow(spec, "/tmp/repo", null, { workflowKind: "quick-fix" });
}

describe("fix-implementer prompt", () => {
	test("uses the workflow specification as the primary instruction", async () => {
		const wf = await makeQuickFix("Fix the invoice date formatting bug");
		const prompt = buildFixImplementPrompt(wf);
		expect(prompt).toContain("Fix the invoice date formatting bug");
		expect(prompt).toMatch(/commit/i);
		expect(prompt).toMatch(/push/i);
	});

	test("appends in-flight feedback entry text as retry context", async () => {
		const wf = await makeQuickFix("Fix X");
		wf.feedbackEntries.push({
			id: "fe-1",
			iteration: 1,
			text: "Also update the tests to cover the empty-array case",
			submittedAt: new Date().toISOString(),
			submittedAtStepName: "fix-implement",
			outcome: null,
		});
		const prompt = buildFixImplementPrompt(wf);
		expect(prompt).toContain("Also update the tests to cover the empty-array case");
	});
});

describe("fix-implementer empty-diff detection", () => {
	test("isEmptyDiff returns true when pre and post HEAD match", () => {
		expect(isEmptyDiff("abc123", "abc123")).toBe(true);
	});

	test("isEmptyDiff returns false when HEADs differ", () => {
		expect(isEmptyDiff("abc123", "def456")).toBe(false);
	});

	test("isEmptyDiff treats missing HEAD as empty (no advance)", () => {
		expect(isEmptyDiff(null, "def456")).toBe(true);
		expect(isEmptyDiff("abc123", null)).toBe(true);
	});

	test("empty-diff error message is the contract-specified string", () => {
		expect(FIX_IMPLEMENT_EMPTY_DIFF_MESSAGE).toBe("no changes produced");
	});
});
