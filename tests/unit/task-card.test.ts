import { afterEach, describe, expect, it } from "bun:test";
import { createTaskCard } from "../../src/client/components/run-screen/task-card";
import type { TaskCardModel } from "../../src/client/components/run-screen/task-card-model";

function baseModel(overrides: Partial<TaskCardModel> = {}): TaskCardModel {
	return {
		id: "wf-1",
		routeId: "wf-1",
		type: "quickfix",
		title: "Fix duplicate output",
		state: "running",
		pipeline: [],
		currentStep: "Fix Implementation",
		elapsedMs: 65_000,
		branchProgress: null,
		selected: false,
		...overrides,
	};
}

describe("task-card", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders the expected width per type", () => {
		const qf = createTaskCard(baseModel({ type: "quickfix" }), () => {});
		const sp = createTaskCard(baseModel({ type: "spec" }), () => {});
		const ep = createTaskCard(baseModel({ type: "epic" }), () => {});
		expect(qf.style.width).toBe("200px");
		expect(sp.style.width).toBe("236px");
		expect(ep.style.width).toBe("280px");
	});

	it("shows the correct abbreviation chip per type", () => {
		const qf = createTaskCard(baseModel({ type: "quickfix" }), () => {});
		const sp = createTaskCard(baseModel({ type: "spec" }), () => {});
		const ep = createTaskCard(baseModel({ type: "epic" }), () => {});
		expect(qf.textContent).toContain("QF");
		expect(sp.textContent).toContain("SP");
		expect(ep.textContent).toContain("EP");
	});

	it("applies selected styling only when selected=true", () => {
		const unsel = createTaskCard(baseModel({ selected: false }), () => {});
		const sel = createTaskCard(baseModel({ selected: true }), () => {});
		expect(unsel.dataset.taskSelected).toBe("false");
		expect(sel.dataset.taskSelected).toBe("true");
		expect(sel.style.boxShadow).toContain("0 0 0 1px");
	});

	it("fires onClick with the routeId + type", () => {
		const captured: { id: string | null; type: string | null } = { id: null, type: null };
		const card = createTaskCard(baseModel({ routeId: "wf-99" }), (id, type) => {
			captured.id = id;
			captured.type = type;
		});
		card.click();
		expect(captured.id).toBe("wf-99");
		expect(captured.type).toBe("quickfix");
	});

	it("epic cards render the `EP · n/m` branch-progress chip (FR-015)", () => {
		const card = createTaskCard(
			baseModel({
				type: "epic",
				branchProgress: { done: 2, total: 5 },
			}),
			() => {},
		);
		document.body.appendChild(card);
		const chip = card.querySelector(".chip") as HTMLElement;
		expect(chip.textContent).toContain("EP");
		expect(chip.textContent).toContain("· 2/5");
	});

	it("non-epic cards don't render a branch-progress chip even when supplied", () => {
		const card = createTaskCard(
			baseModel({ type: "quickfix", branchProgress: { done: 1, total: 3 } }),
			() => {},
		);
		document.body.appendChild(card);
		expect(card.textContent).not.toContain("1/3");
	});

	it("running cards render pulse-dot inside the chip + running state attribute", () => {
		const card = createTaskCard(baseModel({ state: "running" }), () => {});
		document.body.appendChild(card);
		expect(card.dataset.taskState).toBe("running");
		expect(card.querySelector(".chip .pulse-dot")).not.toBeNull();
		// running state-chip text echoes the state.
		const stateSpans = card.querySelectorAll("span.mono");
		const runningChip = Array.from(stateSpans).find((s) => s.textContent === "running");
		expect(runningChip).toBeDefined();
	});

	it("queued cards do not render a pulse-dot", () => {
		const card = createTaskCard(baseModel({ state: "queued" }), () => {});
		document.body.appendChild(card);
		expect(card.querySelector(".chip .pulse-dot")).toBeNull();
	});

	it("pipeline bar: one segment per step, running segment carries the running-step-bar animate hook", () => {
		const card = createTaskCard(
			baseModel({
				pipeline: [
					{ name: "a", state: "done" },
					{ name: "b", state: "running" },
					{ name: "c", state: "queued" },
				],
			}),
			() => {},
		);
		document.body.appendChild(card);
		const bar = card.lastElementChild as HTMLElement;
		const segments = Array.from(bar.children) as HTMLElement[];
		expect(segments.length).toBe(3);
		// FR-015: running segment carries the animation dataset hook.
		expect(segments[0].dataset.litusAnimate).toBeUndefined();
		expect(segments[1].dataset.litusAnimate).toBe("running-step-bar");
		expect(segments[2].dataset.litusAnimate).toBeUndefined();
	});

	it("empty pipeline falls back to the per-type default segment count", () => {
		const qf = createTaskCard(baseModel({ type: "quickfix", pipeline: [] }), () => {});
		const sp = createTaskCard(baseModel({ type: "spec", pipeline: [] }), () => {});
		const ep = createTaskCard(baseModel({ type: "epic", pipeline: [] }), () => {});
		document.body.append(qf, sp, ep);
		expect((qf.lastElementChild as HTMLElement).children.length).toBe(7);
		expect((sp.lastElementChild as HTMLElement).children.length).toBe(9);
		expect((ep.lastElementChild as HTMLElement).children.length).toBe(9);
	});
});
