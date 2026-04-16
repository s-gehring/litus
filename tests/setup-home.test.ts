import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";

describe("test HOME isolation", () => {
	test("homedir() resolves inside tmpdir so ~/.litus defaults cannot touch real user data", () => {
		const home = homedir();
		expect(home.startsWith(tmpdir())).toBe(true);
		expect(home).toContain("litus-test-home-");
	});
});
