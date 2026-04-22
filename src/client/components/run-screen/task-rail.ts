import { LITUS } from "../../design-system/tokens";
import { sectionLabel } from "./primitives";
import { createTaskCard } from "./task-card";
import type { TaskCardModel } from "./task-card-model";

export interface TaskRailHandlers {
	onCardClick: (routeId: string, type: TaskCardModel["type"]) => void;
}

export interface TaskRailController {
	element: HTMLElement;
	update(cards: TaskCardModel[]): void;
}

function rightCounter(cards: TaskCardModel[]): HTMLElement {
	const active = cards.filter((c) => c.state === "running" || c.state === "paused").length;
	const queued = cards.filter((c) => c.state === "queued" || c.state === "blocked").length;
	const done = cards.filter((c) => c.state === "done").length;
	const span = document.createElement("span");
	span.className = "mono";
	Object.assign(span.style, {
		color: LITUS.textMute,
		fontSize: "10.5px",
	} satisfies Partial<CSSStyleDeclaration>);
	span.textContent = `${active} active · ${queued} queued · ${done} done`;
	return span;
}

export function createTaskRail(
	initial: TaskCardModel[],
	handlers: TaskRailHandlers,
): TaskRailController {
	const host = document.createElement("div");
	host.dataset.runScreen = "task-rail";
	Object.assign(host.style, {
		padding: "18px 22px 14px",
	} satisfies Partial<CSSStyleDeclaration>);

	const labelRow = sectionLabel("Active tasks", { right: rightCounter(initial) });
	host.appendChild(labelRow);

	const scroll = document.createElement("div");
	scroll.className = "scroll";
	Object.assign(scroll.style, {
		display: "flex",
		gap: "10px",
		overflowX: "auto",
		paddingBottom: "6px",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(scroll);

	function update(cards: TaskCardModel[]): void {
		// Replace right-side counter
		labelRow.lastChild?.remove();
		labelRow.appendChild(rightCounter(cards));

		scroll.innerHTML = "";
		for (const card of cards) {
			scroll.appendChild(createTaskCard(card, handlers.onCardClick));
		}
	}

	update(initial);
	return { element: host, update };
}
