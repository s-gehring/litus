import { afterEach, describe, expect, it } from "bun:test";
import { createWelcomeEmptyState } from "../../src/client/components/run-screen/welcome-empty-state";

describe("welcome-empty-state (§2.7)", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders eyebrow + headline + lede with load-bearing copy", () => {
		const { element } = createWelcomeEmptyState();
		document.body.appendChild(element);
		expect(element.dataset.runScreen).toBe("welcome");
		expect(element.textContent ?? "").toContain("LITUS");
		expect(element.textContent ?? "").toContain("Pipeline-grade Claude Code.");
		expect(element.textContent ?? "").toContain("Quick Fix, a Specification, or an Epic");
		// Structural: one <h1>, one <p> lede (guards against accidental element drift).
		expect(element.querySelectorAll("h1").length).toBe(1);
		expect(element.querySelectorAll("p").length).toBe(1);
	});
});
