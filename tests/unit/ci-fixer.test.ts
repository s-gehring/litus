import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildFixPrompt, extractRunIds } from "../../src/ci-fixer";
import type { CiCheckResult, CiFailureLog } from "../../src/types";

function extractLogFilePath(prompt: string): string {
	const match = prompt.match(/(?:[A-Z]:\\|\/)[^\s]+ci-fix-[^\s]+\.md/);
	if (!match) throw new Error(`Prompt did not contain a temp log file path:\n${prompt}`);
	return match[0];
}

describe("extractRunIds", () => {
	test("extracts run IDs from check links", () => {
		const checks: CiCheckResult[] = [
			{
				name: "build",
				state: "COMPLETED",
				bucket: "fail",
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
				bucket: "fail",
				link: "https://github.com/owner/repo/actions/runs/12345/job/1",
			},
			{
				name: "lint",
				state: "COMPLETED",
				bucket: "fail",
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
				bucket: "fail",
				link: "https://github.com/owner/repo/actions/runs/111/job/1",
			},
			{
				name: "test",
				state: "COMPLETED",
				bucket: "fail",
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
			{ name: "build", state: "COMPLETED", bucket: "fail", link: "" },
			{ name: "test", state: "COMPLETED", bucket: "fail", link: "no-match" },
		];
		expect(extractRunIds(checks)).toEqual([]);
	});

	test("returns empty array for empty input", () => {
		expect(extractRunIds([])).toEqual([]);
	});
});

describe("buildFixPrompt", () => {
	test("writes logs to a temp file and references it in the prompt", () => {
		const logs: CiFailureLog[] = [
			{ checkName: "build", runId: "123", logs: "error: type mismatch" },
		];
		const prompt = buildFixPrompt("https://github.com/owner/repo/pull/42", logs);

		expect(prompt).toContain("https://github.com/owner/repo/pull/42");
		expect(prompt).toContain("Fix these CI failures");
		expect(prompt).toContain("commit and push");
		expect(prompt).toContain("build (run 123)");
		expect(prompt).toContain("gh run view 123 --log-failed --repo owner/repo");
		// Logs themselves must not appear inline — they live in the temp file.
		expect(prompt).not.toContain("error: type mismatch");

		const filePath = extractLogFilePath(prompt);
		const fileBody = readFileSync(filePath, "utf8");
		expect(fileBody).toContain("### build (run 123)");
		expect(fileBody).toContain("error: type mismatch");
	});

	test("includes every failing check in the prompt and the temp file", () => {
		const logs: CiFailureLog[] = [
			{ checkName: "build", runId: "111", logs: "build error" },
			{ checkName: "test", runId: "222", logs: "test error" },
		];
		const prompt = buildFixPrompt("https://github.com/owner/repo/pull/1", logs);

		expect(prompt).toContain("build (run 111)");
		expect(prompt).toContain("test (run 222)");
		expect(prompt).toContain("gh run view 111 --log-failed --repo owner/repo");
		expect(prompt).toContain("gh run view 222 --log-failed --repo owner/repo");

		const filePath = extractLogFilePath(prompt);
		const fileBody = readFileSync(filePath, "utf8");
		expect(fileBody).toContain("### build (run 111)");
		expect(fileBody).toContain("build error");
		expect(fileBody).toContain("### test (run 222)");
		expect(fileBody).toContain("test error");
	});

	test("keeps the prompt short even when logs would overflow the Windows command-line limit", () => {
		const hugeLog = "x".repeat(60_000);
		const logs: CiFailureLog[] = [
			{ checkName: "build", runId: "1", logs: hugeLog },
			{ checkName: "test", runId: "2", logs: hugeLog },
		];
		const prompt = buildFixPrompt("https://github.com/owner/repo/pull/9", logs);

		// Windows CreateProcessW limit is ~32_767 chars — the prompt must stay well under it.
		expect(prompt.length).toBeLessThan(10_000);
		expect(prompt).not.toContain(hugeLog);

		const filePath = extractLogFilePath(prompt);
		const fileBody = readFileSync(filePath, "utf8");
		expect(fileBody.length).toBeGreaterThan(100_000);
	});

	test("handles empty logs array without writing a temp file", () => {
		const prompt = buildFixPrompt("https://github.com/owner/repo/pull/1", []);
		expect(prompt).toContain("Fix these CI failures");
		expect(prompt).toContain("No failure logs were captured");
		expect(prompt).not.toContain("ci-fix-prompts");
		expect(prompt).not.toContain("###");
	});
});
