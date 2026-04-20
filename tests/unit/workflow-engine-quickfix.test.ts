import { describe, expect, test } from "bun:test";
import {
	nextFixBranchName,
	slugifyFixDescription,
	WorkflowEngine,
} from "../../src/workflow-engine";

describe("createWorkflow (quick-fix)", () => {
	test("produces the 8-step quick-fix order and persists workflowKind", async () => {
		const engine = new WorkflowEngine();
		const wf = await engine.createWorkflow(
			"Fix the date formatting bug on the invoice header",
			"/tmp/test-repo",
			null,
			{ workflowKind: "quick-fix" },
		);
		expect(wf.workflowKind).toBe("quick-fix");
		expect(wf.steps.map((s) => s.name)).toEqual([
			"setup",
			"fix-implement",
			"commit-push-pr",
			"monitor-ci",
			"fix-ci",
			"feedback-implementer",
			"merge-pr",
			"sync-repo",
		]);
	});

	test("rejects empty specification", async () => {
		const engine = new WorkflowEngine();
		expect(
			engine.createWorkflow("", "/tmp/test-repo", null, { workflowKind: "quick-fix" }),
		).rejects.toThrow(/must not be empty/);
		expect(
			engine.createWorkflow("   \n\t  ", "/tmp/test-repo", null, { workflowKind: "quick-fix" }),
		).rejects.toThrow(/must not be empty/);
	});

	test("default workflowKind is spec when option omitted", async () => {
		const engine = new WorkflowEngine();
		const wf = await engine.createWorkflow("Build feature X", "/tmp/test-repo");
		expect(wf.workflowKind).toBe("spec");
	});
});

describe("fix/NNN-<slug> branch-naming helper", () => {
	test("slug derivation keeps ASCII letters/digits and uses dashes", () => {
		expect(slugifyFixDescription("Fix the Date Bug!")).toBe("fix-the-date-bug");
		expect(slugifyFixDescription("   trim  spaces  ")).toBe("trim-spaces");
		expect(slugifyFixDescription("Unicode é stuff — with dash")).toBe("unicode-e-stuff-with-dash");
		expect(slugifyFixDescription("")).toBe("fix");
	});

	test("slug is capped at 40 characters", () => {
		const long = "a".repeat(80);
		const slug = slugifyFixDescription(long);
		expect(slug.length).toBeLessThanOrEqual(40);
	});

	test("numeric sequence starts at 001 when no fix branches exist", () => {
		const name = nextFixBranchName("Fix bug", []);
		expect(name).toBe("fix/001-fix-bug");
	});

	test("numeric sequence avoids collisions with existing fix branches", () => {
		const existing = [
			"  master",
			"* main",
			"  fix/001-old-fix",
			"  fix/002-another",
			"  remotes/origin/fix/003-remote-fix",
		];
		const name = nextFixBranchName("Fix new thing", existing);
		expect(name).toBe("fix/004-fix-new-thing");
	});

	test("numeric sequence fills the lowest available gap", () => {
		const existing = ["fix/001-a", "fix/003-c"];
		const name = nextFixBranchName("gap", existing);
		expect(name).toBe("fix/002-gap");
	});
});
