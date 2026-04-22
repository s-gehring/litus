import { describe, expect, it } from "bun:test";
import { buildLitusPrimitivesCss } from "../../src/client/design-system/primitives.css";

/**
 * happy-dom does not evaluate `@supports` queries (no layout engine), so we
 * can only assert the fallback rule is present in the emitted CSS — the
 * visual verification in Safari + Firefox lives in quickstart.md §5 per SC-002.
 */
describe("backdrop-filter fallback", () => {
	const css = buildLitusPrimitivesCss();

	it("emits the @supports-gated opaque fill for browsers without backdrop-filter", () => {
		expect(css).toMatch(/@supports not \(backdrop-filter:\s*blur\(14px\)\)/);
	});

	it("fallback fill targets the .glass primitive with the pinned rgba", () => {
		const match = css.match(
			/@supports not \(backdrop-filter: blur\(14px\)\)\s*\{[\s\S]*?\.litus \.glass[\s\S]*?background:\s*rgba\(16,\s*22,\s*32,\s*0\.92\)/,
		);
		expect(match).not.toBeNull();
	});
});
