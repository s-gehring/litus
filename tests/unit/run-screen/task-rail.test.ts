import { afterEach, describe, expect, it } from "bun:test";
import type { TaskCardModel } from "../../../src/client/components/run-screen/task-card-model";
import { createTaskRail } from "../../../src/client/components/run-screen/task-rail";

function card(over: Partial<TaskCardModel> = {}): TaskCardModel {
	return {
		id: "task-x",
		routeId: "workflow-x",
		type: "spec",
		state: "queued",
		title: "Task X",
		pipeline: [],
		currentStep: null,
		elapsedMs: 0,
		branchProgress: null,
		selected: false,
		...over,
	};
}

describe("task-rail rightCounter (§2.6 / FR-018)", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("three-bucket tally sums to cards.length (error joins queued)", () => {
		const cards = [
			card({ id: "a", state: "running" }),
			card({ id: "b", state: "paused" }),
			card({ id: "c", state: "queued" }),
			card({ id: "d", state: "blocked" }),
			card({ id: "e", state: "error" }),
			card({ id: "f", state: "done" }),
		];
		const { element } = createTaskRail(cards, { onCardClick: () => {} });
		document.body.appendChild(element);
		// 2 active · 3 queued (queued + blocked + error) · 1 done  = 6
		expect(element.textContent ?? "").toContain("2 active");
		expect(element.textContent ?? "").toContain("3 queued");
		expect(element.textContent ?? "").toContain("1 done");
	});

	it("reconciles cards by id without clearing the scroll container", () => {
		const initial: TaskCardModel[] = [card({ id: "a", title: "A" }), card({ id: "b", title: "B" })];
		const ctrl = createTaskRail(initial, { onCardClick: () => {} });
		document.body.appendChild(ctrl.element);
		const scroll = ctrl.element.querySelector(".scroll") as HTMLElement;
		expect(scroll.children.length).toBe(2);

		// Remove b, add c — the container is still the same element.
		ctrl.update([card({ id: "a", title: "A2" }), card({ id: "c", title: "C" })]);
		expect(scroll.children.length).toBe(2);
		expect(ctrl.element.textContent ?? "").toContain("A2");
		expect(ctrl.element.textContent ?? "").toContain("C");
		expect(ctrl.element.textContent ?? "").not.toContain("B");
	});
});
