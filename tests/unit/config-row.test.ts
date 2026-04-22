import { afterEach, describe, expect, it } from "bun:test";
import { createConfigRow } from "../../src/client/components/run-screen/config-row";

describe("config-row", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders placeholder dashes when tokens/spend metrics are null", () => {
		const { element } = createConfigRow(
			{
				model: "sonnet-4.5",
				effort: "medium",
				metrics: { tokens: null, spendUsd: null },
			},
			{ onModelChange: () => {}, onEffortChange: () => {} },
		);
		document.body.appendChild(element);
		const text = element.textContent ?? "";
		expect(text).toContain("tokens");
		expect(text).toContain("—");
		expect(text).not.toMatch(/\$0/);
	});

	it("fires onModelChange and onEffortChange when buttons are clicked", () => {
		const capture: { model: string | null; effort: string | null } = {
			model: null,
			effort: null,
		};
		const { element } = createConfigRow(
			{ model: "sonnet-4.5", effort: "medium", metrics: { tokens: null, spendUsd: null } },
			{
				onModelChange: (m) => {
					capture.model = m;
				},
				onEffortChange: (e) => {
					capture.effort = e;
				},
			},
		);
		document.body.appendChild(element);
		(element.querySelector('[data-value="opus-4.7"]') as HTMLButtonElement).click();
		(element.querySelector('[data-value="high"]') as HTMLButtonElement).click();
		expect(capture.model).toBe("opus-4.7");
		expect(capture.effort).toBe("high");
	});
});
