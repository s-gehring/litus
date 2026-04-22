import { afterEach, describe, expect, it } from "bun:test";
import { createConfigRow } from "../../src/client/components/run-screen/config-row";
import {
	displayToFullModelId,
	fullToDisplayModelId,
} from "../../src/client/components/run-screen/project-run-screen";

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

	it("highlights the model button matching the supplied display id", () => {
		const { element } = createConfigRow(
			{ model: "opus-4.7", effort: "medium", metrics: { tokens: null, spendUsd: null } },
			{ onModelChange: () => {}, onEffortChange: () => {} },
		);
		document.body.appendChild(element);
		const opus = element.querySelector('[data-value="opus-4.7"]') as HTMLButtonElement;
		const sonnet = element.querySelector('[data-value="sonnet-4.5"]') as HTMLButtonElement;
		// Selected button gets the brighter text colour + non-transparent bg.
		expect(opus.style.background).not.toBe("transparent");
		expect(sonnet.style.background).toBe("transparent");
	});

	it("xhigh and max effort buttons are rendered and clickable", () => {
		const capture: { effort: string | null } = { effort: null };
		const { element } = createConfigRow(
			{ model: "sonnet-4.5", effort: "max", metrics: { tokens: null, spendUsd: null } },
			{
				onModelChange: () => {},
				onEffortChange: (e) => {
					capture.effort = e;
				},
			},
		);
		document.body.appendChild(element);
		expect(element.querySelector('[data-value="xhigh"]')).not.toBeNull();
		const maxBtn = element.querySelector('[data-value="max"]') as HTMLButtonElement;
		expect(maxBtn).not.toBeNull();
		// `max` is the current value → highlighted.
		expect(maxBtn.style.background).not.toBe("transparent");
		(element.querySelector('[data-value="xhigh"]') as HTMLButtonElement).click();
		expect(capture.effort).toBe("xhigh");
		// §3.6: also lock the `max` click — prior test only exercised xhigh.
		maxBtn.click();
		expect(capture.effort).toBe("max");
	});

	it("round-trip: full model id → display id → highlighted button → click emits display id → full id restored", () => {
		// Start with an AppConfig-style full Anthropic id.
		const fullIn = "claude-sonnet-4-5-20250929";
		// 1. Projection layer translates full → display for the UI.
		const displayIn = fullToDisplayModelId(fullIn);
		expect(displayIn).toBe("sonnet-4.5");

		// 2. Config-row highlights the matching button.
		const capture: { model: string | null } = { model: null };
		const { element } = createConfigRow(
			{ model: displayIn, effort: "medium", metrics: { tokens: null, spendUsd: null } },
			{
				onModelChange: (m) => {
					capture.model = m;
				},
				onEffortChange: () => {},
			},
		);
		document.body.appendChild(element);
		const sonnetBtn = element.querySelector('[data-value="sonnet-4.5"]') as HTMLButtonElement;
		expect(sonnetBtn.style.background).not.toBe("transparent");

		// 3. User clicks a different option → callback fires with display id.
		(element.querySelector('[data-value="opus-4.7"]') as HTMLButtonElement).click();
		expect(capture.model).toBe("opus-4.7");

		// 4. Handler-layer helper converts display id → full Anthropic id for
		//    the server-bound `config:save` payload. This is the §1.7 guarantee.
		expect(displayToFullModelId(capture.model ?? "")).toBe("claude-opus-4-7");
	});
});
