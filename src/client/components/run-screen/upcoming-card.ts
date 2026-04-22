import { LITUS } from "../../design-system/tokens";
import { sectionLabel } from "./primitives";

export interface UpcomingCardController {
	element: HTMLElement;
	update(steps: string[]): void;
}

export function createUpcomingCard(initial: string[]): UpcomingCardController {
	const host = document.createElement("div");
	host.className = "glass";
	host.dataset.runScreen = "upcoming-card";
	Object.assign(host.style, {
		borderRadius: "14px",
		padding: "14px 16px",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(sectionLabel("Upcoming"));

	const body = document.createElement("div");
	body.className = "mono";
	Object.assign(body.style, {
		fontSize: "12.5px",
		color: LITUS.textDim,
		lineHeight: "1.55",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(body);

	function update(steps: string[]): void {
		body.innerHTML = "";
		if (steps.length === 0) {
			const done = document.createElement("div");
			done.textContent = "Pipeline complete.";
			done.style.color = LITUS.textDim;
			body.appendChild(done);
			return;
		}
		for (const step of steps) {
			const row = document.createElement("div");
			row.textContent = `→ ${step}`;
			body.appendChild(row);
		}
	}

	update(initial);
	return { element: host, update };
}
