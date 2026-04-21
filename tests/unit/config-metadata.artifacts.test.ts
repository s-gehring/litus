import { describe, expect, test } from "bun:test";
import { NUMERIC_SETTING_META } from "../../src/config-metadata";

describe("artifacts numeric settings (T006)", () => {
	test("limits.artifactsPerFileMaxBytes is a size input with 100MB default", () => {
		const meta = NUMERIC_SETTING_META.find((m) => m.key === "limits.artifactsPerFileMaxBytes");
		expect(meta).toBeDefined();
		expect(meta?.inputKind).toBe("size");
		expect(meta?.defaultValue).toBe(104_857_600);
		expect(meta?.min).toBe(1_048_576);
		expect(meta?.unit).toBe("bytes");
	});

	test("limits.artifactsPerStepMaxBytes is a size input with 1GB default", () => {
		const meta = NUMERIC_SETTING_META.find((m) => m.key === "limits.artifactsPerStepMaxBytes");
		expect(meta).toBeDefined();
		expect(meta?.inputKind).toBe("size");
		expect(meta?.defaultValue).toBe(1_073_741_824);
		expect(meta?.unit).toBe("bytes");
	});

	test("timing.artifactsTimeoutMs is a duration input with 30min default", () => {
		const meta = NUMERIC_SETTING_META.find((m) => m.key === "timing.artifactsTimeoutMs");
		expect(meta).toBeDefined();
		expect(meta?.inputKind).toBe("duration");
		expect(meta?.defaultValue).toBe(1_800_000);
		expect(meta?.unit).toBe("ms");
	});

	test("pre-existing numeric settings do NOT declare inputKind (backwards compat: absent ⇒ scalar)", () => {
		const scalarKeys = [
			"limits.reviewCycleMaxIterations",
			"limits.ciFixMaxAttempts",
			"timing.ciGlobalTimeoutMs",
			"timing.cliIdleTimeoutMs",
		];
		for (const key of scalarKeys) {
			const meta = NUMERIC_SETTING_META.find((m) => m.key === key);
			expect(meta).toBeDefined();
			expect(meta?.inputKind).toBeUndefined();
		}
	});
});
