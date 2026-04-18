import { describe, expect, test } from "bun:test";
import { EFFORT_LEVELS_ORDER, formatEffortLabel } from "../../src/client/components/effort-label";

describe("EFFORT_LEVELS_ORDER canonical ordering", () => {
	test("is low < medium < high < xhigh < max", () => {
		expect(EFFORT_LEVELS_ORDER).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	test("xhigh sits strictly between high and max", () => {
		const highIdx = EFFORT_LEVELS_ORDER.indexOf("high");
		const xhighIdx = EFFORT_LEVELS_ORDER.indexOf("xhigh");
		const maxIdx = EFFORT_LEVELS_ORDER.indexOf("max");
		expect(highIdx).toBeLessThan(xhighIdx);
		expect(xhighIdx).toBeLessThan(maxIdx);
	});
});

describe("formatEffortLabel", () => {
	test("xhigh renders as 'Extra High'", () => {
		expect(formatEffortLabel("xhigh")).toBe("Extra High");
	});

	test("low/medium/high/max are title-cased", () => {
		expect(formatEffortLabel("low")).toBe("Low");
		expect(formatEffortLabel("medium")).toBe("Medium");
		expect(formatEffortLabel("high")).toBe("High");
		expect(formatEffortLabel("max")).toBe("Max");
	});

	test("undefined falls back to 'Default'", () => {
		expect(formatEffortLabel(undefined)).toBe("Default");
	});

	test("raw internal key 'xhigh' never leaks", () => {
		const label = formatEffortLabel("xhigh");
		expect(label).not.toBe("xhigh");
		expect(label).not.toBe("Xhigh");
	});
});
