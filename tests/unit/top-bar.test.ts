import { afterEach, describe, expect, it } from "bun:test";
import { createTopBar } from "../../src/client/components/top-bar";
import type { TopBarModel } from "../../src/client/components/top-bar-model";

function baseModel(over: Partial<TopBarModel> = {}): TopBarModel {
	return {
		version: "1.0.0",
		connected: true,
		repoSlug: "s-gehring/litus",
		autoMode: "manual",
		alertsUnseen: false,
		...over,
	};
}

const noop = () => {};

describe("top-bar", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders version prefixed with `v` and the connection label", () => {
		const { element } = createTopBar(baseModel(), {
			onAutoModeToggle: noop,
			onNewQuickFix: noop,
			onNewSpec: noop,
			onNewEpic: noop,
			onBellClick: noop,
			onGearClick: noop,
		});
		document.body.appendChild(element);
		expect(element.textContent).toContain("v1.0.0");
		expect(element.textContent).toContain("connected · s-gehring/litus");
	});

	it("shows amber pulse on the bell when alertsUnseen is true", () => {
		const onModel = createTopBar(baseModel({ alertsUnseen: false }), {
			onAutoModeToggle: noop,
			onNewQuickFix: noop,
			onNewSpec: noop,
			onNewEpic: noop,
			onBellClick: noop,
			onGearClick: noop,
		});
		document.body.appendChild(onModel.element);
		const bell = onModel.element.querySelector(
			'button[aria-label="Notifications"] span',
		) as HTMLElement;
		expect(bell.style.display).toBe("none");
		onModel.update(baseModel({ alertsUnseen: true }));
		expect(bell.style.display).toBe("inline-block");
	});

	it("fires the correct handler for each creation button", () => {
		const hit = { qf: 0, sp: 0, ep: 0 };
		const { element } = createTopBar(baseModel(), {
			onAutoModeToggle: noop,
			onNewQuickFix: () => {
				hit.qf++;
			},
			onNewSpec: () => {
				hit.sp++;
			},
			onNewEpic: () => {
				hit.ep++;
			},
			onBellClick: noop,
			onGearClick: noop,
		});
		document.body.appendChild(element);
		const buttons = Array.from(element.querySelectorAll("button.btn")).filter((b) =>
			(b.textContent ?? "").includes("New "),
		) as HTMLButtonElement[];
		expect(buttons.length).toBe(3);
		for (const b of buttons) b.click();
		expect(hit).toEqual({ qf: 1, sp: 1, ep: 1 });
	});
});
