import { describe, expect, test } from "bun:test";
import { extractPrUrl } from "../src/pipeline-orchestrator";

describe("extractPrUrl", () => {
	test("extracts a single PR URL from output", () => {
		const output = "Created PR https://github.com/owner/repo/pull/42 successfully";
		expect(extractPrUrl(output)).toBe("https://github.com/owner/repo/pull/42");
	});

	test("returns last URL when multiple PR URLs present", () => {
		const output = [
			"Referenced https://github.com/owner/repo/pull/10",
			"Created https://github.com/owner/repo/pull/42",
		].join("\n");
		expect(extractPrUrl(output)).toBe("https://github.com/owner/repo/pull/42");
	});

	test("returns null when no PR URL found", () => {
		expect(extractPrUrl("No URLs here")).toBeNull();
		expect(extractPrUrl("")).toBeNull();
	});

	test("handles URL at end of output without trailing space", () => {
		const output = "PR: https://github.com/owner/repo/pull/123";
		expect(extractPrUrl(output)).toBe("https://github.com/owner/repo/pull/123");
	});

	test("does not match malformed URLs", () => {
		expect(extractPrUrl("https://github.com/owner/repo/pulls")).toBeNull();
		expect(extractPrUrl("https://github.com/owner/repo/pull/")).toBeNull();
		expect(extractPrUrl("https://gitlab.com/owner/repo/pull/1")).toBeNull();
	});

	test("handles URL with surrounding text and newlines", () => {
		const output = `
Some output text
https://github.com/org/my-repo/pull/999
Done.
`;
		expect(extractPrUrl(output)).toBe("https://github.com/org/my-repo/pull/999");
	});
});
