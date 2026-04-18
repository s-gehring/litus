import { describe, expect, test } from "bun:test";
import { sanitizeBranchForFilename } from "../../src/workflow-artifacts";

describe("sanitizeBranchForFilename", () => {
	test("passes clean alphanumeric branch unchanged", () => {
		expect(sanitizeBranchForFilename("001-workflow-artifacts")).toBe("001-workflow-artifacts");
	});

	test("replaces spaces and slashes", () => {
		expect(sanitizeBranchForFilename("feature/my branch")).toBe("feature-my-branch");
	});

	test("collapses consecutive dashes", () => {
		expect(sanitizeBranchForFilename("a//b  c")).toBe("a-b-c");
	});

	test("strips leading and trailing dashes", () => {
		expect(sanitizeBranchForFilename("--hello--")).toBe("hello");
		expect(sanitizeBranchForFilename("///hello///")).toBe("hello");
	});

	test("replaces non-ASCII with dashes", () => {
		expect(sanitizeBranchForFilename("feat-é-ü")).toBe("feat");
	});

	test("keeps dots and underscores", () => {
		expect(sanitizeBranchForFilename("release_1.2.3")).toBe("release_1.2.3");
	});

	test("empty string stays empty", () => {
		expect(sanitizeBranchForFilename("")).toBe("");
	});
});
