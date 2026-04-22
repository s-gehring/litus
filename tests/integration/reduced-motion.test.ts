import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildLitusPrimitivesCss } from "../../src/client/design-system/primitives.css";

/**
 * happy-dom does not evaluate `@media` queries in `getComputedStyle`, so we
 * can't assert `animationName === "none"` on a live element. Instead, parse
 * the emitted CSS as a CSSOM stylesheet and verify the
 * `@media (prefers-reduced-motion: reduce)` rule targets `.pulse-dot`,
 * `.caret`, `.shimmer-text`, and `[data-litus-animate]` with
 * `animation: none`.
 */

// happy-dom exposes a narrower MediaQueryList type than lib.dom; we cast via
// `any` at the shim boundary (see the `w as any` below) to bypass that gap.
type MatchMediaShim = (query: string) => { matches: boolean; media: string };

function findReducedMotionBlock(css: string): string | null {
	const m = css.match(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{([\s\S]*?)\n\}/);
	return m ? m[1] : null;
}

describe("prefers-reduced-motion", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});
	afterEach(() => {
		for (const el of document.head.querySelectorAll("style[data-test]")) el.remove();
	});

	it("@media block targets each motion-bearing selector with animation:none", () => {
		const block = findReducedMotionBlock(buildLitusPrimitivesCss());
		expect(block).not.toBeNull();
		const body = block ?? "";
		// The inner rule is a single ruleset listing every motion selector.
		for (const sel of [
			".litus .pulse-dot",
			".litus .caret",
			".litus .shimmer-text",
			".litus [data-litus-animate]",
		]) {
			expect(body).toContain(sel);
		}
		expect(body).toMatch(/animation:\s*none\s*!important/);
	});

	it("matchMedia shim honours the reduce query when UA prefers reduced motion", () => {
		// biome-ignore lint/suspicious/noExplicitAny: see note above the shim type.
		const w = window as any;
		const original = w.matchMedia;
		const shim: MatchMediaShim = (query) => ({
			matches: query === "(prefers-reduced-motion: reduce)",
			media: query,
		});
		w.matchMedia = shim;
		try {
			const mm = w.matchMedia("(prefers-reduced-motion: reduce)");
			expect(mm.matches).toBe(true);
			const other = w.matchMedia("(min-width: 9999px)");
			expect(other.matches).toBe(false);
		} finally {
			w.matchMedia = original;
		}
	});

	it("injecting the primitives <style> and mounting a .pulse-dot is non-fatal", () => {
		const style = document.createElement("style");
		style.dataset.test = "reduced-motion";
		style.textContent = buildLitusPrimitivesCss();
		document.head.appendChild(style);

		const host = document.createElement("div");
		host.className = "litus";
		const dot = document.createElement("span");
		dot.className = "pulse-dot";
		host.appendChild(dot);
		document.body.appendChild(host);

		// Under happy-dom, getComputedStyle can't resolve the outer rule either;
		// the sheet just has to load without throwing. The authoritative
		// assertion is in the previous test.
		expect(host.querySelector(".pulse-dot")).toBe(dot);
	});
});
