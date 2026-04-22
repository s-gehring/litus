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

	it("renders running-step duration using the mono primitive + mm:ss format", () => {
		const { element } = createPipelineStepper(
			{
				type: "quickfix",
				steps: [{ name: "Run", state: "running", durationMs: 65_000 }],
				currentIndex: 0,
			},
			accent,
			{ onStepClick: () => {} },
		);
		document.body.appendChild(element);
		const wrap = element.querySelector('[data-step-name="Run"]') as HTMLElement;
		const dur = wrap.querySelector(".mono") as HTMLElement;
		expect(dur).not.toBeNull();
		expect(dur.textContent).toBe("01:05");
		// The primitives CSS class `.mono` carries the monospace font-family
		// rule; happy-dom's CSSOM drops oklch() colours from inline styles so
		// we verify the class assignment is the load-bearing signal here.
		expect(dur.classList.contains("mono")).toBe(true);
	});

	it("steps without a running state don't render a duration row when durationMs is absent", () => {
		const { element } = createPipelineStepper(
			{
				type: "quickfix",
				steps: [{ name: "Pending", state: "queued" }],
				currentIndex: 0,
			},
			accent,
			{ onStepClick: () => {} },
		);
		document.body.appendChild(element);
		const wrap = element.querySelector('[data-step-name="Pending"]') as HTMLElement;
		expect(wrap.querySelector(".mono")).toBeNull();
	});

	it("click on a step node fires onStepClick with the step name", () => {
		const capture: { name: string | null } = { name: null };
		const { element } = createPipelineStepper(
			{
				type: "quickfix",
				steps: [
					{ name: "Setup", state: "done" },
					{ name: "Run", state: "running" },
				],
				currentIndex: 1,
			},
			accent,
			{
				onStepClick: (name) => {
					capture.name = name;
				},
			},
		);
		document.body.appendChild(element);
		const wrap = element.querySelector('[data-step-name="Setup"]') as HTMLElement;
		wrap.click();
		expect(capture.name).toBe("Setup");
	});

	it("Enter and Space keydown fire onStepClick (§2.9)", () => {
		const seen: string[] = [];
		const { element } = createPipelineStepper(
			{
				type: "quickfix",
				steps: [{ name: "Setup", state: "done" }],
				currentIndex: 0,
			},
			accent,
			{
				onStepClick: (name) => {
					seen.push(name);
				},
			},
		);
		document.body.appendChild(element);
		const wrap = element.querySelector('[data-step-name="Setup"]') as HTMLElement;
		wrap.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		wrap.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
		wrap.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
		expect(seen).toEqual(["Setup", "Setup"]);
	});

	it("skip-node renders a dashed border", () => {
		const { element } = createPipelineStepper(
			{
				type: "quickfix",
				steps: [{ name: "Fix CI", state: "skip" }],
				currentIndex: 0,
			},
			accent,
			{ onStepClick: () => {} },
		);
		document.body.appendChild(element);
		const node = element.querySelector('[data-step-name="Fix CI"] div') as HTMLElement;
		expect(node.style.border).toContain("dashed");
	});

	it("currentIndex = -1 renders `queued · ...` counter (§2.8)", () => {
		const { element } = createPipelineStepper(
			{
				type: "quickfix",
				steps: [
					{ name: "Setup", state: "queued" },
					{ name: "Run", state: "queued" },
				],
				currentIndex: -1,
			},
			accent,
			{ onStepClick: () => {} },
		);
		document.body.appendChild(element);
		// Header label "Pipeline" sits in the first element; counter is the last child of the header row.
		expect(element.textContent).toContain("queued · quickfix pipeline");
		expect(element.textContent).not.toMatch(/step 1 \/ 2/);
	});

	it("rail gradient fill width grows with currentIndex", () => {
		const base = {
			type: "quickfix" as const,
			steps: [
				{ name: "a", state: "done" as const },
				{ name: "b", state: "done" as const },
				{ name: "c", state: "running" as const },
				{ name: "d", state: "queued" as const },
			],
		};

		function fillPctFor(currentIndex: number): number {
			const { element } = createPipelineStepper({ ...base, currentIndex }, accent, {
				onStepClick: () => {},
			});
			document.body.appendChild(element);
			// railFill is the second absolutely-positioned child of the grid.
			const fill = element.querySelector(
				'[data-run-screen="pipeline-stepper"] > div > div',
			) as HTMLElement | null;
			// Walk to the railFill: grid has railBase (idx 0), railFill (idx 1), stepsGrid (idx 2).
			const grid = element.querySelector(
				'[data-run-screen="pipeline-stepper"] > div:nth-child(2)',
			) as HTMLElement;
			const railFill = grid.children[1] as HTMLElement;
			void fill;
			const width = railFill.style.width;
			const m = width.match(/calc\(([\d.]+)%\s*\)/);
			return m ? Number.parseFloat(m[1]) : -1;
		}

		const early = fillPctFor(0);
		const mid = fillPctFor(1);
		const late = fillPctFor(3);
		expect(early).toBeGreaterThan(0);
		expect(mid).toBeGreaterThan(early);
		expect(late).toBeGreaterThan(mid);
		expect(late).toBeLessThanOrEqual(100);
	});
});
