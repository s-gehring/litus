import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import "../happydom";
import {
	ACTION_REGISTRY,
	type ActionSpec,
	clearDetailActions,
	renderDetailActions,
} from "../../src/client/components/detail-actions";

const HOST = '<div id="detail-actions" class="detail-actions hidden"></div>';

function buttons(): HTMLButtonElement[] {
	return Array.from(document.querySelectorAll<HTMLButtonElement>("#detail-actions button"));
}

function testIds(): string[] {
	return buttons().map((b) => b.getAttribute("data-testid") ?? "");
}

function slots(): string[] {
	return buttons().map((b) => b.getAttribute("data-slot") ?? "");
}

function clickConfirmModalConfirm(): void {
	const modal = document.querySelector(".confirm-modal");
	const confirmBtn = modal?.querySelector(".btn-primary") as HTMLButtonElement | null;
	confirmBtn?.click();
}

function clickConfirmModalCancel(): void {
	const modal = document.querySelector(".confirm-modal");
	const cancelBtn = modal?.querySelector(".btn-secondary") as HTMLButtonElement | null;
	cancelBtn?.click();
}

describe("detail-actions / slot-based renderer", () => {
	beforeEach(() => {
		document.body.innerHTML = HOST;
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	test("hides the bar when no specs are passed", () => {
		const container = document.getElementById("detail-actions") as HTMLElement;
		container.classList.remove("hidden");
		renderDetailActions([]);
		expect(container.classList.contains("hidden")).toBe(true);
		expect(buttons()).toHaveLength(0);
	});

	test("clearDetailActions is equivalent to renderDetailActions([])", () => {
		const container = document.getElementById("detail-actions") as HTMLElement;
		renderDetailActions([{ key: "pause", onClick: () => {} }]);
		expect(buttons()).toHaveLength(1);
		clearDetailActions();
		expect(buttons()).toHaveLength(0);
		expect(container.classList.contains("hidden")).toBe(true);
	});

	test("renders one button per spec, in slot order regardless of spec order", () => {
		// Specs are in arbitrary order; renderer must reorder to slot order:
		// primary → secondary → destructive → finalize.
		const specs: ActionSpec[] = [
			{ key: "archive", onClick: () => {} },
			{ key: "abort", onClick: () => {} },
			{ key: "retry-step", onClick: () => {} },
			{ key: "pause", onClick: () => {} },
		];
		renderDetailActions(specs);
		expect(testIds()).toEqual([
			"action-pause",
			"action-retry-step",
			"action-abort",
			"action-archive",
		]);
		expect(slots()).toEqual(["primary", "secondary", "destructive", "finalize"]);
	});

	test("test-id is derived from key, never from label", () => {
		// Label override changes the visible text but not the selector.
		renderDetailActions([
			{ key: "start-children", onClick: () => {}, labelOverride: "Start 27 specs" },
		]);
		const btn = buttons()[0];
		expect(btn.getAttribute("data-testid")).toBe("action-start-children");
		expect(btn.textContent).toBe("Start 27 specs");
	});

	test("falls back to registry label when no override is given", () => {
		renderDetailActions([{ key: "pause", onClick: () => {} }]);
		expect(buttons()[0]?.textContent).toBe(ACTION_REGISTRY.pause.label);
	});

	test("first button on the right side gets a slot-break class", () => {
		// secondary acts as the left-most "right side" only when destructive +
		// finalize are absent, but the convention is that the break goes on the
		// FIRST destructive / finalize button.
		renderDetailActions([
			{ key: "pause", onClick: () => {} },
			{ key: "retry-step", onClick: () => {} },
			{ key: "abort", onClick: () => {} },
			{ key: "archive", onClick: () => {} },
		]);
		const btns = buttons();
		expect(
			btns
				.find((b) => b.getAttribute("data-testid") === "action-abort")
				?.classList.contains("slot-break"),
		).toBe(true);
		expect(
			btns
				.find((b) => b.getAttribute("data-testid") === "action-archive")
				?.classList.contains("slot-break"),
		).toBe(false);
	});

	test("only one slot-break is emitted per render", () => {
		// Even when multiple destructive + finalize buttons are present, only
		// the first non-(primary|secondary) gets the auto-margin spacer.
		renderDetailActions([
			{ key: "abort", onClick: () => {} },
			{ key: "retry-workflow", onClick: () => {} },
			{ key: "archive", onClick: () => {} },
		]);
		expect(buttons().filter((b) => b.classList.contains("slot-break"))).toHaveLength(1);
	});

	test("disabled spec renders a real disabled attribute and a tooltip", () => {
		const onClick = mock(() => {});
		renderDetailActions([
			{
				key: "archive",
				onClick,
				disabled: { reason: "Cannot archive while running" },
			},
		]);
		const btn = buttons()[0];
		expect(btn.disabled).toBe(true);
		expect(btn.getAttribute("aria-disabled")).toBe("true");
		expect(btn.title).toBe("Cannot archive while running");
		expect(btn.classList.contains("btn-disabled")).toBe(true);
		btn.click();
		expect(onClick).not.toHaveBeenCalled();
	});

	test("loading flag adds btn-loading without disabling click", () => {
		const onClick = mock(() => {});
		renderDetailActions([{ key: "start-children", onClick, loading: true }]);
		const btn = buttons()[0];
		expect(btn.classList.contains("btn-loading")).toBe(true);
		expect(btn.disabled).toBe(false);
		btn.click();
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	test("button without confirm fires onClick directly", () => {
		const onClick = mock(() => {});
		renderDetailActions([{ key: "pause", onClick }]);
		buttons()[0].click();
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	test("registry-confirmed action shows a modal and only fires onClick on confirm", async () => {
		const onClick = mock(() => {});
		renderDetailActions([{ key: "abort", onClick }]);
		buttons()[0].click();
		// Modal is now in the DOM.
		expect(document.querySelector(".confirm-modal")).not.toBeNull();
		expect(onClick).not.toHaveBeenCalled();
		clickConfirmModalConfirm();
		// Wait a microtask for the showConfirmModal Promise to resolve.
		await Promise.resolve();
		await Promise.resolve();
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(document.querySelector(".confirm-modal")).toBeNull();
	});

	test("registry-confirmed action does NOT fire onClick on cancel", async () => {
		const onClick = mock(() => {});
		renderDetailActions([{ key: "retry-workflow", onClick }]);
		buttons()[0].click();
		expect(document.querySelector(".confirm-modal")).not.toBeNull();
		clickConfirmModalCancel();
		await Promise.resolve();
		await Promise.resolve();
		expect(onClick).not.toHaveBeenCalled();
	});

	test("confirmOverride: null suppresses the registry confirm", async () => {
		const onClick = mock(() => {});
		renderDetailActions([{ key: "abort", onClick, confirmOverride: null }]);
		buttons()[0].click();
		expect(document.querySelector(".confirm-modal")).toBeNull();
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	test("confirmOverride object replaces the registry confirm copy", async () => {
		const onClick = mock(() => {});
		renderDetailActions([
			{
				key: "archive",
				onClick,
				confirmOverride: {
					title: "Custom title",
					body: "Custom body",
					confirmLabel: "Custom",
					cancelLabel: "Nope",
				},
			},
		]);
		buttons()[0].click();
		const modal = document.querySelector(".confirm-modal");
		expect(modal?.querySelector(".confirm-modal-title")?.textContent).toBe("Custom title");
		expect(modal?.querySelector(".confirm-modal-body")?.textContent).toBe("Custom body");
		clickConfirmModalCancel();
		await Promise.resolve();
		await Promise.resolve();
		expect(onClick).not.toHaveBeenCalled();
	});

	test("re-rendering replaces the previous buttons rather than appending", () => {
		renderDetailActions([{ key: "pause", onClick: () => {} }]);
		expect(buttons()).toHaveLength(1);
		renderDetailActions([
			{ key: "resume", onClick: () => {} },
			{ key: "abort", onClick: () => {} },
		]);
		expect(buttons()).toHaveLength(2);
		expect(testIds()).toEqual(["action-resume", "action-abort"]);
	});

	test("registry guarantees Pause and Resume share the primary slot/class", () => {
		// They are peer actions on the same lifecycle and must look the same.
		expect(ACTION_REGISTRY.pause.slot).toBe("primary");
		expect(ACTION_REGISTRY.resume.slot).toBe("primary");
		expect(ACTION_REGISTRY.pause.className).toBe("btn-primary");
		expect(ACTION_REGISTRY.resume.className).toBe("btn-primary");
	});

	test("registry guarantees retry-workflow uses warning style + modal confirm", () => {
		expect(ACTION_REGISTRY["retry-workflow"].className).toBe("btn-warning");
		expect(ACTION_REGISTRY["retry-workflow"].slot).toBe("destructive");
		expect(ACTION_REGISTRY["retry-workflow"].confirm).toBeDefined();
	});

	test("registry guarantees abort uses danger style + modal confirm", () => {
		expect(ACTION_REGISTRY.abort.className).toBe("btn-danger");
		expect(ACTION_REGISTRY.abort.slot).toBe("destructive");
		expect(ACTION_REGISTRY.abort.confirm).toBeDefined();
	});

	test("registry guarantees archive lives in the finalize slot", () => {
		expect(ACTION_REGISTRY.archive.slot).toBe("finalize");
		expect(ACTION_REGISTRY["view-archive"].slot).toBe("finalize");
	});
});
