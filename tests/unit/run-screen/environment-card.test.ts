import { afterEach, describe, expect, it } from "bun:test";
import { createEnvironmentCard } from "../../../src/client/components/run-screen/environment-card";
import type { RunScreenEnvironment } from "../../../src/client/components/run-screen/run-screen-model";

function env(over: Partial<RunScreenEnvironment> = {}): RunScreenEnvironment {
	return {
		worktree: null,
		python: null,
		node: null,
		pnpm: null,
		claudeMdLoaded: false,
		skills: [],
		...over,
	};
}

describe("environment-card (§3.3)", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("paints `✓ loaded` when claudeMdLoaded is true, dot placeholder when false", () => {
		const { element, update } = createEnvironmentCard(env({ claudeMdLoaded: false }));
		document.body.appendChild(element);
		expect(element.textContent ?? "").not.toContain("✓ loaded");

		update(env({ claudeMdLoaded: true }));
		expect(element.textContent ?? "").toContain("✓ loaded");
	});

	it("renders skills as a comma-separated list or `·` when empty", () => {
		const { element, update } = createEnvironmentCard(env({ skills: [] }));
		document.body.appendChild(element);
		// No skill names in the textContent.
		expect(element.textContent ?? "").not.toContain("brainstorm");

		update(
			env({
				skills: [
					{ name: "brainstorm", count: 3 },
					{ name: "refactor", count: 1 },
				],
			}),
		);
		expect(element.textContent ?? "").toContain("brainstorm · 3");
		expect(element.textContent ?? "").toContain("refactor · 1");
	});

	it("substitutes `·` for null env values", () => {
		const { element } = createEnvironmentCard(env({ worktree: null, node: null }));
		document.body.appendChild(element);
		expect(element.textContent ?? "").toContain("·");
	});
});
