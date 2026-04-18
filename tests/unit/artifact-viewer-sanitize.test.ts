// Note: `renderMarkdown` constructs a DOMPurify instance against `window`.
// These tests therefore rely on Bun's built-in happy-dom shim being active;
// if the runtime's DOM is ever disabled, this import itself will throw.
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../src/client/render-markdown";

describe("artifact viewer markdown sanitization (FR-008)", () => {
	test("script tags are stripped by the shared dompurify sanitizer", () => {
		const input = "# title\n\n<script>alert('xss')</script>\n\ntext";
		const out = renderMarkdown(input);
		expect(out).not.toContain("<script");
		expect(out).not.toContain("alert('xss')");
	});

	test("javascript: URLs in links are neutralized", () => {
		const input = "[click](javascript:alert(1))";
		const out = renderMarkdown(input);
		// Structural check: either the anchor is dropped entirely, or if one
		// remains, its href must not point at a javascript: URL. This catches
		// any evasion (e.g. embedded NUL, mixed case) that a substring check
		// on the raw output would miss.
		const container = document.createElement("div");
		container.innerHTML = out;
		const dangerousSchemes = ["javascript:", "data:", "vbscript:"];
		for (const anchor of Array.from(container.querySelectorAll("a"))) {
			const href = (anchor.getAttribute("href") ?? "").trim().toLowerCase();
			for (const scheme of dangerousSchemes) {
				expect(href.startsWith(scheme)).toBe(false);
			}
		}
		expect(out.toLowerCase()).not.toContain("javascript:");
	});

	test("safe markdown still renders", () => {
		const out = renderMarkdown("# hi\n\n- a\n- b");
		expect(out).toContain("<h1");
		expect(out).toContain("<li>a</li>");
	});
});
