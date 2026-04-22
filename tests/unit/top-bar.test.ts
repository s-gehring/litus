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

	it("suppresses `onAutoModeToggle` when the user clicks the already-active segment (§2.2)", () => {
		// Reason: the server's tri-state (`manual` | `normal` | `full-auto`)
		// is collapsed to binary on the toggle. Firing on a no-op click would
		// silently downgrade `full-auto` to `normal` on round-trip.
		const captured: { fired: number; lastMode: "auto" | "manual" | null } = {
			fired: 0,
			lastMode: null,
		};
		const { element, update } = createTopBar(baseModel({ autoMode: "auto" }), {
			onAutoModeToggle: (m) => {
				captured.fired++;
				captured.lastMode = m;
			},
			onNewQuickFix: noop,
			onNewSpec: noop,
			onNewEpic: noop,
			onBellClick: noop,
			onGearClick: noop,
		});
		document.body.appendChild(element);
		const autoBtn = element.querySelector<HTMLButtonElement>('button[data-mode="auto"]');
		const manualBtn = element.querySelector<HTMLButtonElement>('button[data-mode="manual"]');
		if (!autoBtn || !manualBtn) throw new Error("segments missing");
		autoBtn.click();
		expect(captured.fired).toBe(0);
		manualBtn.click();
		expect(captured.fired).toBe(1);
		expect(captured.lastMode).toBe("manual");
		update(baseModel({ autoMode: "manual" }));
		manualBtn.click();
		expect(captured.fired).toBe(1);
	});

	it("Auto/Manual Left/Right arrows rove focus between segments (§2.3 / contract §1.3)", () => {
		const { element } = createTopBar(baseModel({ autoMode: "manual" }), {
			onAutoModeToggle: noop,
			onNewQuickFix: noop,
			onNewSpec: noop,
			onNewEpic: noop,
			onBellClick: noop,
			onGearClick: noop,
		});
		document.body.appendChild(element);
		const autoBtn = element.querySelector<HTMLButtonElement>('button[data-mode="auto"]');
		const manualBtn = element.querySelector<HTMLButtonElement>('button[data-mode="manual"]');
		if (!autoBtn || !manualBtn) throw new Error("segments missing");
		autoBtn.focus();
		autoBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		expect(document.activeElement).toBe(manualBtn);
		manualBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
		expect(document.activeElement).toBe(autoBtn);
	});

	it("dot colour and label track the connection state (incl. hidden when no repo) (§3.5, §4.9)", () => {
		const { element, update } = createTopBar(baseModel({ connected: true }), {
			onAutoModeToggle: noop,
			onNewQuickFix: noop,
			onNewSpec: noop,
			onNewEpic: noop,
			onBellClick: noop,
			onGearClick: noop,
		});
		document.body.appendChild(element);
		expect(element.textContent).toContain("s-gehring/litus");
		update(baseModel({ connected: false }));
		expect(element.textContent).toContain("disconnected");
		update(baseModel({ connected: true, repoSlug: null }));
		// When connected without a repo slug, the label is hidden per contract §1.2.
		expect(element.textContent).not.toContain("connected");
	});

	it("fires onGearClick / onBellClick on the header icon buttons", () => {
		let gear = 0;
		let bell = 0;
		const { element } = createTopBar(baseModel(), {
			onAutoModeToggle: noop,
			onNewQuickFix: noop,
			onNewSpec: noop,
			onNewEpic: noop,
			onBellClick: () => {
				bell++;
			},
			onGearClick: () => {
				gear++;
			},
		});
		document.body.appendChild(element);
		element.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')?.click();
		element.querySelector<HTMLButtonElement>('button[aria-label="Notifications"]')?.click();
		expect({ gear, bell }).toEqual({ gear: 1, bell: 1 });
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
