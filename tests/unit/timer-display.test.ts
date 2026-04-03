import { describe, expect, test } from "bun:test";
import { formatTimer } from "../../src/client/components/workflow-cards";

describe("Client-side timer interpolation", () => {
	test("static activeWorkMs when not running (no startedAt)", () => {
		expect(formatTimer(0, null)).toBe("0:00");
		expect(formatTimer(5000, null)).toBe("0:05");
		expect(formatTimer(65000, null)).toBe("1:05");
		expect(formatTimer(3600000, null)).toBe("1:00:00");
	});

	test("interpolates live delta when activeWorkStartedAt is set", () => {
		const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
		const result = formatTimer(10000, fiveSecondsAgo);

		// Should be approximately 15 seconds (10s accumulated + 5s live)
		// Allow 1s tolerance for test execution time
		expect(result).toMatch(/^0:1[45]$/);
	});

	test("timer pauses on waiting_for_input (startedAt null)", () => {
		// When workflow transitions to waiting_for_input, server sets startedAt = null
		// and accumulates the time into activeWorkMs
		const result = formatTimer(30000, null);
		expect(result).toBe("0:30");
	});

	test("timer resumes after answer (startedAt set again)", () => {
		const twoSecondsAgo = new Date(Date.now() - 2000).toISOString();
		const result = formatTimer(30000, twoSecondsAgo);
		// Should be ~32 seconds
		expect(result).toMatch(/^0:3[12]$/);
	});

	test("hours format for long-running workflows", () => {
		expect(formatTimer(7200000, null)).toBe("2:00:00");
		expect(formatTimer(3661000, null)).toBe("1:01:01");
	});

	test("zero timer displays correctly", () => {
		expect(formatTimer(0, null)).toBe("0:00");
	});
});
