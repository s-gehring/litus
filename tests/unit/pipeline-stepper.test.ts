import { afterEach, describe, expect, it } from "bun:test";
import { createPipelineStepper } from "../../src/client/components/run-screen/pipeline-stepper";
import { typeAccent } from "../../src/client/design-system/tokens";

const accent = typeAccent("quickfix");

describe("pipeline-stepper", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders one node per step and sizes the running node larger", () => {
		const { element } = createPipelineStepper(
			{
				type: "quickfix",
				steps: [
					{ name: "Setup", state: "done" },
					{ name: "Fix Implementation", state: "running", durationMs: 5000 },
					{ name: "Create PR", state: "queued" },
					{ name: "Fix CI", state: "skip" },
				],
				currentIndex: 1,
			},
			accent,
			{ onStepClick: () => {} },
		);
		document.body.appendChild(element);

		const wraps = element.querySelectorAll("[data-step-name]");
		expect(wraps.length).toBe(4);

		const running = element.querySelector('[data-step-name="Fix Implementation"] div');
		expect((running as HTMLElement).style.width).toBe("22px");

		const done = element.querySelector('[data-step-name="Setup"] div');
		expect((done as HTMLElement).style.width).toBe("14px");
	});

	it("bold-faces the running label and strikethroughs the skip label", () => {
		const { element } = createPipelineStepper(
			{
				type: "quickfix",
				steps: [
					{ name: "Fix Implementation", state: "running" },
					{ name: "Fix CI", state: "skip" },
				],
				currentIndex: 0,
			},
			accent,
			{ onStepClick: () => {} },
		);
		document.body.appendChild(element);
		const running = element.querySelector(
			'[data-step-name="Fix Implementation"] div div',
		) as HTMLElement;
		expect(running.style.fontWeight).toBe("600");
		const skip = element.querySelector('[data-step-name="Fix CI"] div div') as HTMLElement;
		expect(skip.style.textDecoration).toContain("line-through");
	});
});
