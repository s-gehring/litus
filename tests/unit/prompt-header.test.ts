import { describe, expect, test } from "bun:test";
import { CLAUDE_MD_CONTRACT_HEADER } from "../../src/prompt-header";

describe("CLAUDE_MD_CONTRACT_HEADER", () => {
	test("is a non-empty string containing the anchor phrase", () => {
		expect(typeof CLAUDE_MD_CONTRACT_HEADER).toBe("string");
		expect(CLAUDE_MD_CONTRACT_HEADER.length).toBeGreaterThan(0);
		expect(CLAUDE_MD_CONTRACT_HEADER).toContain("CLAUDE.md is Litus-managed local context");
	});
});
