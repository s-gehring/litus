import { describe, expect, it } from "bun:test";
import { buildLitusPrimitivesCss } from "../../../src/client/design-system/primitives.css";
import {
	LITUS,
	type LitusTokens,
	type TaskType,
	TOKEN_CSS_VAR,
	typeAccent,
} from "../../../src/client/design-system/tokens";

describe("LITUS token set", () => {
	it("every token is a non-empty string", () => {
		for (const key of Object.keys(LITUS) as Array<keyof LitusTokens>) {
			expect(typeof LITUS[key]).toBe("string");
			expect(LITUS[key].length).toBeGreaterThan(0);
		}
	});

	it("CSS custom-property map covers every LitusTokens key 1:1", () => {
		const tokenKeys = Object.keys(LITUS).sort();
		const varKeys = Object.keys(TOKEN_CSS_VAR).sort();
		expect(varKeys).toEqual(tokenKeys);
		for (const key of varKeys) {
			expect(TOKEN_CSS_VAR[key as keyof LitusTokens]).toMatch(/^--litus-[a-z-]+$/);
		}
	});
});

describe("typeAccent", () => {
	it("returns reference-stable objects per type", () => {
		const types: TaskType[] = ["quickfix", "spec", "epic"];
		for (const t of types) {
			expect(typeAccent(t)).toBe(typeAccent(t));
		}
	});

	it("returns the expected label/abbr per type", () => {
		expect(typeAccent("quickfix").abbr).toBe("QF");
		expect(typeAccent("quickfix").label).toBe("Quick Fix");
		expect(typeAccent("spec").abbr).toBe("SP");
		expect(typeAccent("spec").label).toBe("Specification");
		expect(typeAccent("epic").abbr).toBe("EP");
		expect(typeAccent("epic").label).toBe("Epic");
	});

	it("each accent's c/dim/glow trio comes from the LITUS palette", () => {
		expect(typeAccent("quickfix").c).toBe(LITUS.amber);
		expect(typeAccent("quickfix").dim).toBe(LITUS.amberDim);
		expect(typeAccent("quickfix").glow).toBe(LITUS.amberGlow);
		expect(typeAccent("spec").c).toBe(LITUS.cyan);
		expect(typeAccent("epic").c).toBe(LITUS.violet);
	});
});

describe("buildLitusPrimitivesCss", () => {
	const css = buildLitusPrimitivesCss();

	it("contains every primitive class selector", () => {
		const classes = [
			".litus",
			".litus .mono",
			".litus .serif",
			".litus .chip",
			".litus .dot",
			".litus .pulse-dot",
			".litus .glass",
			".litus .hairline",
			".litus .btn",
			".litus .btn-ghost",
			".litus .kbd",
			".litus .scroll",
			".litus .caret",
			".litus .shimmer-text",
		];
		for (const sel of classes) {
			expect(css).toContain(sel);
		}
	});

	it("declares all three keyframes", () => {
		expect(css).toContain("@keyframes litusPulse");
		expect(css).toContain("@keyframes litusBlink");
		expect(css).toContain("@keyframes litusShimmer");
	});

	it("emits the prefers-reduced-motion guard", () => {
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
		expect(css).toContain("animation: none !important");
	});

	it("emits the @supports backdrop-filter fallback", () => {
		expect(css).toMatch(/@supports not \(backdrop-filter:/);
		expect(css).toContain("rgba(16, 22, 32, 0.92)");
	});

	it("exposes every token as a custom property under .litus", () => {
		for (const key of Object.keys(TOKEN_CSS_VAR) as Array<keyof LitusTokens>) {
			expect(css).toContain(`${TOKEN_CSS_VAR[key]}: ${LITUS[key]};`);
		}
	});
});
