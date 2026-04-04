import { describe, expect, test } from "bun:test";
import { buildFixPrompt, extractRunIds } from "../../src/ci-fixer";
import type { CiCheckResult, CiFailureLog } from "../../src/types";

describe("extractRunIds", () => {
	test("extracts run IDs from check links", () => {
		const checks: CiCheckResult[] = [
			{
				name: "build",
				state: "COMPLETED",
				conclusion: "FAILURE",
				link: "https://github.com/owner/repo/actions/runs/12345/job/67890",
			},
		];
		expect(extractRunIds(checks)).toEqual([{ checkName: "build", runId: "12345" }]);
	});

	test("deduplicates run IDs across multiple checks", () => {
		const checks: CiCheckResult[] = [
			{
				name: "build",
				state: "COMPLETED",
				conclusion: "FAILURE",
				link: "https://github.com/owner/repo/actions/runs/12345/job/1",
			},
			{
				name: "lint",
				state: "COMPLETED",
				conclusion: "FAILURE",
				link: "https://github.com/owner/repo/actions/runs/12345/job/2",
			},
		];
		const result = extractRunIds(checks);
		expect(result).toHaveLength(1);
		expect(result[0].runId).toBe("12345");
	});

	test("handles multiple distinct run IDs", () => {
		const checks: CiCheckResult[] = [
			{
				name: "build",
				state: "COMPLETED",
				conclusion: "FAILURE",
				link: "https://github.com/owner/repo/actions/runs/111/job/1",
			},
			{
				name: "test",
				state: "COMPLETED",
				conclusion: "FAILURE",
				link: "https://github.com/owner/repo/actions/runs/222/job/2",
			},
		];
		expect(extractRunIds(checks)).toEqual([
			{ checkName: "build", runId: "111" },
			{ checkName: "test", runId: "222" },
		]);
	});

	test("skips checks with no matching link", () => {
		const checks: CiCheckResult[] = [
			{ name: "build", state: "COMPLETED", conclusion: "FAILURE", link: "" },
			{ name: "test", state: "COMPLETED", conclusion: "FAILURE", link: "no-match" },
		];
		expect(extractRunIds(checks)).toEqual([]);
	});

	test("returns empty array for empty input", () => {
		expect(extractRunIds([])).toEqual([]);
	});
});

describe("buildFixPrompt", () => {
	test("constructs prompt with failure logs", () => {
		const logs: CiFailureLog[] = [
			{ checkName: "build", runId: "123", logs: "error: type mismatch" },
		];
		const prompt = buildFixPrompt("https://github.com/owner/repo/pull/42", logs);
		expect(prompt).toContain("https://github.com/owner/repo/pull/42");
		expect(prompt).toContain("### build (run 123)");
		expect(prompt).toContain("error: type mismatch");
		expect(prompt).toContain("Fix these CI failures");
		expect(prompt).toContain("commit and push");
	});

	test("includes multiple failure logs", () => {
		const logs: CiFailureLog[] = [
			{ checkName: "build", runId: "111", logs: "build error" },
			{ checkName: "test", runId: "222", logs: "test error" },
		];
		const prompt = buildFixPrompt("https://github.com/owner/repo/pull/1", logs);
		expect(prompt).toContain("### build (run 111)");
		expect(prompt).toContain("### test (run 222)");
	});

	test("handles empty logs array", () => {
		const prompt = buildFixPrompt("https://github.com/owner/repo/pull/1", []);
		expect(prompt).toContain("Fix these CI failures");
		expect(prompt).not.toContain("###");
	});
});
