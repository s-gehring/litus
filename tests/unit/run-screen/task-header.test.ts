import { afterEach, describe, expect, it } from "bun:test";
import type { RunScreenModel } from "../../../src/client/components/run-screen/run-screen-model";
import { createTaskHeader } from "../../../src/client/components/run-screen/task-header";
import { typeAccent } from "../../../src/client/design-system/tokens";

function model(over: Partial<RunScreenModel> = {}): RunScreenModel {
	const base: RunScreenModel = {
		id: "12345678-abcd-0000-0000-000000000000",
		type: "spec",
		title: "My Task",
		state: "running",
		paused: false,
		header: {
			createdAt: Date.now() - 65_000,
			branch: "feat/x",
			worktree: "/tmp/x",
			base: null,
			description: "Task description.",
		},
		pipeline: { type: "spec", steps: [], currentIndex: 0 },
		config: { model: "sonnet-4.5", effort: "medium", metrics: { tokens: null, spendUsd: null } },
		log: {
			events: [],
			writingLineIndex: null,
			currentStep: null,
			counters: { toolCalls: 0, reads: 0, edits: 0 },
		},
		env: {
			worktree: null,
			python: null,
			node: null,
			pnpm: null,
			claudeMdLoaded: false,
			skills: [],
		},
		touched: [],
		upcoming: [],
	};
	return { ...base, ...over };
}

describe("task-header (§3.2)", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders the chip with a truncated 8-char id and full id in the title tooltip (§4.12)", () => {
		const m = model();
		const { element } = createTaskHeader(m, typeAccent(m.type), { onPauseToggle: () => {} });
		document.body.appendChild(element);
		const id = element.querySelector<HTMLElement>("span.mono");
		expect(id?.textContent).toBe("#12345678");
		expect(id?.title).toBe(m.id);
	});

	it("tick() advances the elapsed display without rebuilding the span node", () => {
		const m = model({ header: { ...model().header, createdAt: Date.now() - 30_000 } });
		const ctrl = createTaskHeader(m, typeAccent(m.type), { onPauseToggle: () => {} });
		document.body.appendChild(ctrl.element);
		const spans = Array.from(ctrl.element.querySelectorAll("span.mono"));
		const elapsedBefore = spans.map((s) => s.textContent).find((t) => t?.startsWith("elapsed "));
		expect(elapsedBefore).toMatch(/elapsed \d\d:\d\d:\d\d/);

		ctrl.tick();
		// Same element tree, just re-rendered text.
		expect(ctrl.element.querySelectorAll("span.mono").length).toBe(spans.length);
	});

	it("Timeline button is disabled with aria-disabled, tabIndex=-1, and `Coming soon` title (contract §3.6)", () => {
		const m = model();
		const { element } = createTaskHeader(m, typeAccent(m.type), { onPauseToggle: () => {} });
		document.body.appendChild(element);
		const timeline = Array.from(element.querySelectorAll("button")).find((b) =>
			(b.textContent ?? "").includes("Timeline"),
		);
		expect(timeline?.getAttribute("aria-disabled")).toBe("true");
		expect(timeline?.tabIndex).toBe(-1);
		expect(timeline?.title).toBe("Coming soon");
	});

	it("pause button flips paint optimistically on click before the server reconciles (§2.5)", () => {
		const m = model({ paused: false });
		let calls = 0;
		const ctrl = createTaskHeader(m, typeAccent(m.type), {
			onPauseToggle: () => {
				calls++;
			},
		});
		document.body.appendChild(ctrl.element);
		const pauseBtn = Array.from(ctrl.element.querySelectorAll("button")).find((b) =>
			(b.textContent ?? "").includes("Pause"),
		);
		if (!pauseBtn) throw new Error("pause button missing");
		pauseBtn.click();
		expect(calls).toBe(1);
		// The button now paints as "Resume" even though no server message has
		// come back yet.
		const nowShowsResume = Array.from(ctrl.element.querySelectorAll("button")).some((b) =>
			(b.textContent ?? "").includes("Resume"),
		);
		expect(nowShowsResume).toBe(true);
	});

	it("meta row mutates values in place rather than re-creating children on update (§2.7)", () => {
		const m = model();
		const ctrl = createTaskHeader(m, typeAccent(m.type), { onPauseToggle: () => {} });
		document.body.appendChild(ctrl.element);
		const branchLabel = Array.from(ctrl.element.querySelectorAll("span")).find(
			(s) => s.textContent === "branch",
		);
		if (!branchLabel) throw new Error("branch label missing");
		const valueBefore = branchLabel.nextSibling as HTMLElement;
		expect(valueBefore.textContent).toBe("feat/x");

		ctrl.update({ ...m, header: { ...m.header, branch: "feat/y" } }, typeAccent(m.type));
		// Same value element, mutated in place.
		const branchLabelAfter = Array.from(ctrl.element.querySelectorAll("span")).find(
			(s) => s.textContent === "branch",
		);
		expect(branchLabelAfter?.nextSibling).toBe(valueBefore);
		expect(valueBefore.textContent).toBe("feat/y");
	});
});
