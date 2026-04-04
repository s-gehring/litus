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
			{ name: "build", state: "COMPLETED", conclusion: "SUCCESS", link: "https://example.com" },
			{ name: "test", state: "PENDING", conclusion: null, link: "" },
		]);
		const results = parseCiChecks(json);
		expect(results).toEqual([
			{ name: "build", state: "COMPLETED", conclusion: "SUCCESS", link: "https://example.com" },
			{ name: "test", state: "PENDING", conclusion: null, link: "" },
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
		expect(results).toEqual([{ name: "", state: "", conclusion: null, link: "" }]);
	});

	test("coerces non-null conclusion to string", () => {
		const json = JSON.stringify([{ name: "a", state: "COMPLETED", conclusion: 42, link: "" }]);
		const results = parseCiChecks(json);
		expect(results[0].conclusion).toBe("42");
	});
});

describe("allChecksComplete", () => {
	test("returns true when all checks are COMPLETED", () => {
		expect(
			allChecksComplete([
				{ name: "a", state: "COMPLETED", conclusion: "SUCCESS", link: "" },
				{ name: "b", state: "COMPLETED", conclusion: "FAILURE", link: "" },
			]),
		).toBe(true);
	});

	test("returns false when any check is not COMPLETED", () => {
		expect(
			allChecksComplete([
				{ name: "a", state: "COMPLETED", conclusion: "SUCCESS", link: "" },
				{ name: "b", state: "PENDING", conclusion: null, link: "" },
			]),
		).toBe(false);
	});

	test("returns true for empty array", () => {
		expect(allChecksComplete([])).toBe(true);
	});

	test("returns false for IN_PROGRESS state", () => {
		expect(
			allChecksComplete([{ name: "a", state: "IN_PROGRESS", conclusion: null, link: "" }]),
		).toBe(false);
	});
});

describe("allChecksPassed", () => {
	test("returns true when all conclusions are SUCCESS", () => {
		expect(
			allChecksPassed([
				{ name: "a", state: "COMPLETED", conclusion: "SUCCESS", link: "" },
				{ name: "b", state: "COMPLETED", conclusion: "SUCCESS", link: "" },
			]),
		).toBe(true);
	});

	test("returns false when any conclusion is not SUCCESS", () => {
		expect(
			allChecksPassed([
				{ name: "a", state: "COMPLETED", conclusion: "SUCCESS", link: "" },
				{ name: "b", state: "COMPLETED", conclusion: "FAILURE", link: "" },
			]),
		).toBe(false);
	});

	test("returns true for empty array", () => {
		expect(allChecksPassed([])).toBe(true);
	});

	test("returns false when conclusion is null", () => {
		expect(allChecksPassed([{ name: "a", state: "PENDING", conclusion: null, link: "" }])).toBe(
			false,
		);
	});

	test("returns false for CANCELLED conclusion", () => {
		expect(
			allChecksPassed([{ name: "a", state: "COMPLETED", conclusion: "CANCELLED", link: "" }]),
		).toBe(false);
	});
});

describe("allFailuresCancelled", () => {
	test("returns true when all non-SUCCESS checks are CANCELLED", () => {
		expect(
			allFailuresCancelled([
				{ name: "a", state: "COMPLETED", conclusion: "SUCCESS", link: "" },
				{ name: "b", state: "COMPLETED", conclusion: "CANCELLED", link: "" },
			]),
		).toBe(true);
	});

	test("returns true when all checks are CANCELLED", () => {
		expect(
			allFailuresCancelled([
				{ name: "a", state: "COMPLETED", conclusion: "CANCELLED", link: "" },
				{ name: "b", state: "COMPLETED", conclusion: "CANCELLED", link: "" },
			]),
		).toBe(true);
	});

	test("returns false when some failures are not CANCELLED", () => {
		expect(
			allFailuresCancelled([
				{ name: "a", state: "COMPLETED", conclusion: "FAILURE", link: "" },
				{ name: "b", state: "COMPLETED", conclusion: "CANCELLED", link: "" },
			]),
		).toBe(false);
	});

	test("returns false when all checks passed", () => {
		expect(
			allFailuresCancelled([{ name: "a", state: "COMPLETED", conclusion: "SUCCESS", link: "" }]),
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
