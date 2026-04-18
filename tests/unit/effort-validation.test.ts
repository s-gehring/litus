import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../src/config-store";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "effort-validation-test-"));
}

describe("EffortLevel validation accepts xhigh", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("writing xhigh to efforts.implement validates successfully", () => {
		const store = new ConfigStore(join(dir, "config.json"));
		const result = store.save({ efforts: { implement: "xhigh" } });
		expect(result.errors).toEqual([]);
		expect(store.get().efforts.implement).toBe("xhigh");
	});

	test("writing each canonical level validates successfully", () => {
		const store = new ConfigStore(join(dir, "config.json"));
		for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
			const result = store.save({ efforts: { implement: level } });
			expect(result.errors).toEqual([]);
		}
	});

	test("writing an invalid effort reports a validation error naming all five levels", () => {
		const store = new ConfigStore(join(dir, "config.json"));
		const result = store.save({
			efforts: { implement: "bogus" as unknown as "low" },
		});
		expect(result.errors.length).toBe(1);
		const msg = result.errors[0].message;
		expect(msg).toContain("low");
		expect(msg).toContain("medium");
		expect(msg).toContain("high");
		expect(msg).toContain("xhigh");
		expect(msg).toContain("max");
	});
});
