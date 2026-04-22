import { describe, expect, test } from "bun:test";
import {
	buildFixImplementPrompt,
	classifyFixImplementDiff,
	FIX_IMPLEMENT_EMPTY_DIFF_MESSAGE,
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

	test("prepends the CLAUDE.md contract header exactly once (T012)", async () => {
		const wf = await makeQuickFix("Fix X");
		const prompt = buildFixImplementPrompt(wf);
		const phrase = "CLAUDE.md is Litus-managed local context";
		expect(prompt).toContain(phrase);
		expect(prompt.split(phrase).length - 1).toBe(1);
		expect(prompt.startsWith("## CLAUDE.md is Litus-managed local context")).toBe(true);
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

describe("fix-implementer diff classification", () => {
	test("matching HEADs classify as empty", () => {
		expect(classifyFixImplementDiff("abc123", "abc123")).toEqual({ kind: "empty" });
	});

	test("differing HEADs classify as changes", () => {
		expect(classifyFixImplementDiff("abc123", "def456")).toEqual({ kind: "changes" });
	});

	test("missing HEAD on either side classifies as head-read-failed (distinct from empty)", () => {
		expect(classifyFixImplementDiff(null, "def456")).toEqual({ kind: "head-read-failed" });
		expect(classifyFixImplementDiff("abc123", null)).toEqual({ kind: "head-read-failed" });
	});

	test("empty-diff error message is the contract-specified string", () => {
		expect(FIX_IMPLEMENT_EMPTY_DIFF_MESSAGE).toBe("no changes produced");
	});
});
