import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../src/client/render-markdown";

describe("renderMarkdown", () => {
	describe("XSS sanitization", () => {
		test("strips script tags", () => {
			const result = renderMarkdown('<script>alert("xss")</script>');
			expect(result).not.toContain("<script");
		});

		test("strips onerror event handlers", () => {
			const result = renderMarkdown('<img src="x" onerror="alert(1)">');
			expect(result).not.toContain("onerror");
		});

		test("strips onclick event handlers", () => {
			const result = renderMarkdown('<div onclick="alert(1)">click me</div>');
			expect(result).not.toContain("onclick");
		});

		test("strips javascript: URLs from links", () => {
			const result = renderMarkdown('<a href="javascript:alert(1)">click</a>');
			expect(result).not.toContain("javascript:");
		});

		test("strips javascript: URLs from markdown links", () => {
			const result = renderMarkdown("[click](javascript:alert(1))");
			expect(result).not.toContain("javascript:");
		});

		test("strips nested XSS vectors", () => {
			const result = renderMarkdown(
				'<div><img src="x" onerror="alert(1)"><script>alert(2)</script></div>',
			);
			expect(result).not.toContain("<script");
			expect(result).not.toContain("onerror");
		});

		test("strips HTML entity-decoded payloads", () => {
			const result = renderMarkdown("<img src=x onerror=&#97;&#108;&#101;&#114;&#116;(1)>");
			expect(result).not.toContain("onerror");
		});
	});

	describe("falsy input handling", () => {
		test("returns empty string for empty string", () => {
			expect(renderMarkdown("")).toBe("");
		});

		test("returns empty string for undefined", () => {
			// @ts-expect-error testing falsy input
			expect(renderMarkdown(undefined)).toBe("");
		});

		test("returns empty string for null", () => {
			// @ts-expect-error testing falsy input
			expect(renderMarkdown(null)).toBe("");
		});
	});

	describe("legitimate markdown preservation", () => {
		test("renders headings", () => {
			const result = renderMarkdown("# Heading 1");
			expect(result).toContain("<h1");
			expect(result).toContain("Heading 1");
		});

		test("renders bold and italic", () => {
			const bold = renderMarkdown("**bold text**");
			expect(bold).toContain("<strong>");
			expect(bold).toContain("bold text");

			const italic = renderMarkdown("*italic text*");
			expect(italic).toContain("<em>");
			expect(italic).toContain("italic text");
		});

		test("renders unordered lists", () => {
			const result = renderMarkdown("- item 1\n- item 2");
			expect(result).toContain("<ul>");
			expect(result).toContain("<li>");
			expect(result).toContain("item 1");
		});

		test("renders ordered lists", () => {
			const result = renderMarkdown("1. first\n2. second");
			expect(result).toContain("<ol>");
			expect(result).toContain("<li>");
		});

		test("renders code blocks", () => {
			const result = renderMarkdown("```\nconst x = 1;\n```");
			expect(result).toContain("<code>");
			expect(result).toContain("const x = 1;");
		});

		test("renders inline code", () => {
			const result = renderMarkdown("`inline code`");
			expect(result).toContain("<code>");
			expect(result).toContain("inline code");
		});

		test("preserves valid links", () => {
			const result = renderMarkdown("[example](https://example.com)");
			expect(result).toContain("<a");
			expect(result).toContain('href="https://example.com"');
			expect(result).toContain("example");
		});

		test("preserves valid images", () => {
			const result = renderMarkdown("![alt text](https://example.com/img.png)");
			expect(result).toContain("<img");
			expect(result).toContain('src="https://example.com/img.png"');
			expect(result).toContain('alt="alt text"');
		});
	});
});
