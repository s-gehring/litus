import { describe, expect, test } from "bun:test";
import { canonicalKey, looksLikeGitUrl, parseGitHubUrl } from "../../src/git-url";

describe("parseGitHubUrl — accepted forms", () => {
	test("https with .git suffix", () => {
		expect(parseGitHubUrl("https://github.com/foo/bar.git")).toEqual({ owner: "foo", repo: "bar" });
	});

	test("https without .git suffix", () => {
		expect(parseGitHubUrl("https://github.com/foo/bar")).toEqual({ owner: "foo", repo: "bar" });
	});

	test("https with trailing slash", () => {
		expect(parseGitHubUrl("https://github.com/foo/bar/")).toEqual({ owner: "foo", repo: "bar" });
	});

	test("http (insecure)", () => {
		expect(parseGitHubUrl("http://github.com/foo/bar.git")).toEqual({ owner: "foo", repo: "bar" });
	});

	test("git@ SSH form with .git", () => {
		expect(parseGitHubUrl("git@github.com:foo/bar.git")).toEqual({ owner: "foo", repo: "bar" });
	});

	test("git@ SSH form without .git", () => {
		expect(parseGitHubUrl("git@github.com:foo/bar")).toEqual({ owner: "foo", repo: "bar" });
	});

	test("ssh:// form", () => {
		expect(parseGitHubUrl("ssh://git@github.com/foo/bar.git")).toEqual({
			owner: "foo",
			repo: "bar",
		});
	});

	test("ssh:// form without .git", () => {
		expect(parseGitHubUrl("ssh://git@github.com/foo/bar")).toEqual({
			owner: "foo",
			repo: "bar",
		});
	});

	test("strips surrounding whitespace", () => {
		expect(parseGitHubUrl("  https://github.com/foo/bar.git  ")).toEqual({
			owner: "foo",
			repo: "bar",
		});
	});

	test("handles hyphens and dots in owner/repo", () => {
		expect(parseGitHubUrl("https://github.com/foo-bar/baz.qux.git")).toEqual({
			owner: "foo-bar",
			repo: "baz.qux",
		});
	});
});

describe("parseGitHubUrl — rejected inputs", () => {
	test("rejects gitlab URLs", () => {
		expect(parseGitHubUrl("https://gitlab.com/foo/bar.git")).toBeNull();
	});

	test("rejects bitbucket URLs", () => {
		expect(parseGitHubUrl("git@bitbucket.org:foo/bar.git")).toBeNull();
	});

	test("rejects plain local paths", () => {
		expect(parseGitHubUrl("/tmp/foo/bar")).toBeNull();
	});

	test("rejects empty string", () => {
		expect(parseGitHubUrl("")).toBeNull();
	});

	test("rejects whitespace only", () => {
		expect(parseGitHubUrl("   ")).toBeNull();
	});

	test("rejects github URL missing repo", () => {
		expect(parseGitHubUrl("https://github.com/foo")).toBeNull();
	});

	test("rejects github URL missing owner", () => {
		expect(parseGitHubUrl("https://github.com/")).toBeNull();
	});

	test("rejects garbage string", () => {
		expect(parseGitHubUrl("not a url at all")).toBeNull();
	});
});

describe("looksLikeGitUrl", () => {
	test("true for https/http/ssh/git@", () => {
		expect(looksLikeGitUrl("https://github.com/foo/bar.git")).toBe(true);
		expect(looksLikeGitUrl("http://example.com/x")).toBe(true);
		expect(looksLikeGitUrl("ssh://git@github.com/foo/bar")).toBe(true);
		expect(looksLikeGitUrl("git@github.com:foo/bar")).toBe(true);
	});
	test("false for local paths", () => {
		expect(looksLikeGitUrl("/tmp/foo")).toBe(false);
		expect(looksLikeGitUrl("C:\\git\\repo")).toBe(false);
		expect(looksLikeGitUrl("~/git/foo")).toBe(false);
		expect(looksLikeGitUrl("")).toBe(false);
	});
});

describe("canonicalKey", () => {
	test("lowercases the pair", () => {
		expect(canonicalKey("Foo", "Bar")).toBe("foo/bar");
	});

	test("different URL forms for same repo yield same canonical key", () => {
		const a = parseGitHubUrl("https://github.com/Foo/Bar.git");
		const b = parseGitHubUrl("git@github.com:Foo/Bar");
		const c = parseGitHubUrl("ssh://git@github.com/foo/bar.git");
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(c).not.toBeNull();
		if (!a || !b || !c) return;
		expect(canonicalKey(a.owner, a.repo)).toBe("foo/bar");
		expect(canonicalKey(b.owner, b.repo)).toBe("foo/bar");
		expect(canonicalKey(c.owner, c.repo)).toBe("foo/bar");
	});
});
