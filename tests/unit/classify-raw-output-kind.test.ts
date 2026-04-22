import { describe, expect, it } from "bun:test";
import { classifyRawOutputKind } from "../../src/cli-runner";

describe("classifyRawOutputKind (§3.7)", () => {
	it("tags shell-prompt lines as `cmd`", () => {
		expect(classifyRawOutputKind("$ npm install")).toBe("cmd");
		expect(classifyRawOutputKind("  $ git status")).toBe("cmd");
		// Bracketed cwd prefix.
		expect(classifyRawOutputKind("[~/repo]$ ls")).toBe("cmd");
	});

	it("tags unified-diff markers as `diff`", () => {
		expect(classifyRawOutputKind("@@ -1,3 +1,4 @@")).toBe("diff");
		expect(classifyRawOutputKind("+++ b/path/to/file")).toBe("diff");
		expect(classifyRawOutputKind("--- a/path/to/file")).toBe("diff");
		expect(classifyRawOutputKind("◇ some/path.ts")).toBe("diff");
	});

	it("returns undefined for unrelated output lines", () => {
		expect(classifyRawOutputKind("Hello world")).toBeUndefined();
		expect(classifyRawOutputKind("")).toBeUndefined();
		// `$` without a following token is ambiguous — not classed as cmd.
		expect(classifyRawOutputKind("$")).toBeUndefined();
		// `@@` without the full unified-diff header shape — not classed as diff.
		expect(classifyRawOutputKind("@@")).toBeUndefined();
	});
});
