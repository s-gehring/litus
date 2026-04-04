import { describe, expect, test } from "bun:test";
import {
	allChecksComplete,
	allChecksPassed,
	allFailuresCancelled,
	isValidPrUrl,
	parseCiChecks,
} from "../../src/ci-monitor";

describe("parseCiChecks", () => {
	test("parses valid JSON array of check results", () => {
		const json = JSON.stringify([
			{ name: "build", state: "COMPLETED", bucket: "pass", link: "https://example.com" },
			{ name: "test", state: "PENDING", bucket: "pending", link: "" },
		]);
		const results = parseCiChecks(json);
		expect(results).toEqual([
			{ name: "build", state: "COMPLETED", bucket: "pass", link: "https://example.com" },
			{ name: "test", state: "PENDING", bucket: "pending", link: "" },
		]);
	});

	test("returns empty array for non-array JSON", () => {
		expect(parseCiChecks(JSON.stringify({ name: "build" }))).toEqual([]);
	});

	test("throws on malformed JSON", () => {
		expect(() => parseCiChecks("not json")).toThrow();
	});

	test("returns empty array for empty JSON array", () => {
		expect(parseCiChecks("[]")).toEqual([]);
	});

	test("handles missing fields with defaults", () => {
		const json = JSON.stringify([{}]);
		const results = parseCiChecks(json);
		expect(results).toEqual([{ name: "", state: "", bucket: "pending", link: "" }]);
	});

	test("coerces bucket to string", () => {
		const json = JSON.stringify([{ name: "a", state: "COMPLETED", bucket: 42, link: "" }]);
		const results = parseCiChecks(json);
		expect(results[0].bucket).toBe("42");
	});
});

describe("allChecksComplete", () => {
	test("returns true when all checks are COMPLETED", () => {
		expect(
			allChecksComplete([
				{ name: "a", state: "COMPLETED", bucket: "pass", link: "" },
				{ name: "b", state: "COMPLETED", bucket: "fail", link: "" },
			]),
		).toBe(true);
	});

	test("returns false when any check is not COMPLETED", () => {
		expect(
			allChecksComplete([
				{ name: "a", state: "COMPLETED", bucket: "pass", link: "" },
				{ name: "b", state: "PENDING", bucket: "pending", link: "" },
			]),
		).toBe(false);
	});

	test("returns true for empty array", () => {
		expect(allChecksComplete([])).toBe(true);
	});

	test("returns false for IN_PROGRESS state", () => {
		expect(
			allChecksComplete([{ name: "a", state: "IN_PROGRESS", bucket: "pending", link: "" }]),
		).toBe(false);
	});
});

describe("allChecksPassed", () => {
	test("returns true when all buckets are pass", () => {
		expect(
			allChecksPassed([
				{ name: "a", state: "COMPLETED", bucket: "pass", link: "" },
				{ name: "b", state: "COMPLETED", bucket: "pass", link: "" },
			]),
		).toBe(true);
	});

	test("returns false when any bucket is not pass", () => {
		expect(
			allChecksPassed([
				{ name: "a", state: "COMPLETED", bucket: "pass", link: "" },
				{ name: "b", state: "COMPLETED", bucket: "fail", link: "" },
			]),
		).toBe(false);
	});

	test("returns true for empty array", () => {
		expect(allChecksPassed([])).toBe(true);
	});

	test("returns false when bucket is pending", () => {
		expect(allChecksPassed([{ name: "a", state: "PENDING", bucket: "pending", link: "" }])).toBe(
			false,
		);
	});

	test("returns false for cancel bucket", () => {
		expect(
			allChecksPassed([{ name: "a", state: "COMPLETED", bucket: "cancel", link: "" }]),
		).toBe(false);
	});
});

describe("allFailuresCancelled", () => {
	test("returns true when all non-pass checks are cancel", () => {
		expect(
			allFailuresCancelled([
				{ name: "a", state: "COMPLETED", bucket: "pass", link: "" },
				{ name: "b", state: "COMPLETED", bucket: "cancel", link: "" },
			]),
		).toBe(true);
	});

	test("returns true when all checks are cancel", () => {
		expect(
			allFailuresCancelled([
				{ name: "a", state: "COMPLETED", bucket: "cancel", link: "" },
				{ name: "b", state: "COMPLETED", bucket: "cancel", link: "" },
			]),
		).toBe(true);
	});

	test("returns false when some failures are not cancel", () => {
		expect(
			allFailuresCancelled([
				{ name: "a", state: "COMPLETED", bucket: "fail", link: "" },
				{ name: "b", state: "COMPLETED", bucket: "cancel", link: "" },
			]),
		).toBe(false);
	});

	test("returns false when all checks passed", () => {
		expect(
			allFailuresCancelled([{ name: "a", state: "COMPLETED", bucket: "pass", link: "" }]),
		).toBe(false);
	});

	test("returns false for empty array", () => {
		expect(allFailuresCancelled([])).toBe(false);
	});
});

describe("isValidPrUrl", () => {
	test("accepts valid GitHub PR URLs", () => {
		expect(isValidPrUrl("https://github.com/owner/repo/pull/42")).toBe(true);
		expect(isValidPrUrl("https://github.com/my-org/my-repo/pull/1")).toBe(true);
	});

	test("rejects URLs with trailing paths", () => {
		expect(isValidPrUrl("https://github.com/owner/repo/pull/42/files")).toBe(false);
		expect(isValidPrUrl("https://github.com/owner/repo/pull/42/checks")).toBe(false);
	});

	test("rejects non-GitHub URLs", () => {
		expect(isValidPrUrl("https://gitlab.com/owner/repo/pull/42")).toBe(false);
	});

	test("rejects malformed PR URLs", () => {
		expect(isValidPrUrl("https://github.com/owner/repo/pulls")).toBe(false);
		expect(isValidPrUrl("https://github.com/owner/repo/pull/")).toBe(false);
		expect(isValidPrUrl("https://github.com/owner/pull/42")).toBe(false);
		expect(isValidPrUrl("not a url")).toBe(false);
		expect(isValidPrUrl("")).toBe(false);
	});
});
