import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cssPath = resolve(import.meta.dir, "../public/style.css");
const css = readFileSync(cssPath, "utf-8");

describe("responsive layout CSS rules", () => {
	test("#app uses clamp() for fluid width", () => {
		expect(css).toContain("clamp(320px, 90vw, 1800px)");
	});

	test("text-heavy elements have max-width: 80ch", () => {
		for (const selector of [".welcome-text", ".question-content", ".card-summary"]) {
			// Match only the standalone rule (selector immediately followed by `{`),
			// not compound selectors like `.user-input p, .question-content p { ... }`.
			const ruleRegex = new RegExp(
				`${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\{`,
			);
			const match = ruleRegex.exec(css);
			expect(match).not.toBeNull();
			const selectorIndex = match?.index ?? -1;
			const ruleBlock = css.slice(selectorIndex, css.indexOf("}", selectorIndex));
			expect(ruleBlock).toContain("max-width: 80ch");
		}
	});

	test(".output-log spans full width without max-width constraint", () => {
		const idx = css.indexOf(".output-log");
		expect(idx).not.toBe(-1);
		const ruleBlock = css.slice(idx, css.indexOf("}", idx));
		expect(ruleBlock).not.toContain("max-width");
	});

	test("includes tablet breakpoint at 1200px", () => {
		expect(css).toContain("@media (max-width: 1200px)");
	});

	test("includes mobile breakpoint at 768px", () => {
		expect(css).toContain("@media (max-width: 768px)");
	});

	test("mobile breakpoint sets full width", () => {
		const mobileQuery = css.slice(css.indexOf("@media (max-width: 768px)"));
		expect(mobileQuery).toContain("width: 100%");
	});
});
