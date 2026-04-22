import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildLitusPrimitivesCss } from "../../src/client/design-system/primitives.css";

describe("prefers-reduced-motion", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});
	afterEach(() => {
		for (const el of document.head.querySelectorAll("style[data-test]")) el.remove();
	});

	it("CSS includes the prefers-reduced-motion guard that disables new animations", () => {
		const css = buildLitusPrimitivesCss();
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
		expect(css).toMatch(/\.pulse-dot,[\s\S]*animation:\s*none\s*!important/);
	});

	it("inject + serialize: the emitted <style> sheet contains the guard", () => {
		const style = document.createElement("style");
		style.dataset.test = "reduced-motion";
		style.textContent = buildLitusPrimitivesCss();
		document.head.appendChild(style);
		expect(style.textContent).toContain("prefers-reduced-motion: reduce");
	});
});
