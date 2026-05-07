import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cssPath = resolve(import.meta.dir, "../public/style.css");
const css = readFileSync(cssPath, "utf-8");

function ruleBlock(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`${escaped}\\s*\\{`);
	const match = regex.exec(css);
	if (!match) throw new Error(`selector not found: ${selector}`);
	const open = match.index + match[0].length;
	return css.slice(open, css.indexOf("}", open));
}

describe("card hover/selected visibility", () => {
	test("workflow-card hover has a ring + glow box-shadow (not just border-color)", () => {
		const block = ruleBlock(".workflow-card:hover");
		expect(block).toContain("box-shadow:");
		// Outer ring layer (0 0 0 1px) + soft outer glow.
		expect(block).toContain("0 0 0 1px var(--accent-blue)");
	});

	test("workflow-card selected (.card-expanded) uses a 2px accent ring + strong glow", () => {
		const block = ruleBlock(".workflow-card.card-expanded");
		expect(block).toContain("0 0 0 2px var(--accent-blue)");
		// Stronger glow than the previous 0.3 alpha — at least 0.5 so it reads at a glance.
		expect(/rgba\(74,\s*158,\s*255,\s*0\.5\)/.test(block)).toBe(true);
	});

	test("quick-fix card hover keeps orange identity with ring + glow", () => {
		const block = ruleBlock(".workflow-card--quick-fix:hover");
		expect(block).toContain("0 0 0 1px var(--accent-orange)");
		expect(block).toContain("rgba(240, 148, 60");
	});

	test("ask-question card hover keeps violet identity with ring + glow", () => {
		const block = ruleBlock(".workflow-card--ask-question:hover");
		expect(block).toContain("0 0 0 1px var(--accent-violet)");
		expect(block).toContain("rgba(178, 136, 255");
	});

	test("epic card selected keeps a 2px ring on top of its existing glow", () => {
		const block = ruleBlock(".workflow-card--epic.card-expanded");
		expect(block).toContain("0 0 0 2px var(--accent-blue)");
		expect(block).toContain("var(--epic-glow-color)");
	});

	test("tree-node hover has a ring + glow (matches workflow card style)", () => {
		const block = ruleBlock(".tree-node:hover");
		expect(block).toContain("0 0 0 1px var(--accent-blue)");
	});

	test("tree-node-highlighted uses a 2px accent ring + strong glow", () => {
		const block = ruleBlock(".tree-node-highlighted");
		expect(block).toContain("0 0 0 2px var(--accent-blue)");
	});
});
