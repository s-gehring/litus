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
});
