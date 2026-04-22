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
	// FR-018 / spec §5: rail counters are a three-bucket split that must sum
	// to `cards.length`. Paused collapses into active (still "in flight" from
	// the user's perspective); `error` / `blocked` join `queued` so the error
	// card does not vanish from the tally.
	const active = cards.filter((c) => c.state === "running" || c.state === "paused").length;
	const done = cards.filter((c) => c.state === "done").length;
	const queued = cards.length - active - done;
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

	// Reconcile cards by id — preserve horizontal scroll position and preserve
	// element identity when the card data is unchanged, so hover/focus state on
	// a card survives the 1-second `tickInterval` fire (§3.1 / carryover §2.1).
	const mounted = new Map<string, { el: HTMLElement; signature: string }>();

	function cardSignature(card: TaskCardModel): string {
		// Shallow content hash keyed on everything `createTaskCard` renders.
		// When the signature is unchanged we skip the rebuild entirely and
		// keep the existing DOM node (identity preservation).
		return JSON.stringify([
			card.type,
			card.state,
			card.title,
			card.currentStep,
			card.elapsedMs,
			card.selected,
			card.branchProgress?.done ?? null,
			card.branchProgress?.total ?? null,
			card.pipeline.map((p) => [p.name, p.state]),
		]);
	}

	function update(cards: TaskCardModel[]): void {
		labelRow.lastChild?.remove();
		labelRow.appendChild(rightCounter(cards));

		const seen = new Set<string>();
		for (let i = 0; i < cards.length; i++) {
			const card = cards[i];
			seen.add(card.id);
			const signature = cardSignature(card);
			const existing = mounted.get(card.id);
			let node: HTMLElement;
			if (existing && existing.signature === signature && existing.el.parentElement === scroll) {
				// Data unchanged — reuse the existing node (preserves focus/hover).
				node = existing.el;
			} else if (existing && existing.el.parentElement === scroll) {
				const fresh = createTaskCard(card, handlers.onCardClick);
				existing.el.replaceWith(fresh);
				node = fresh;
			} else {
				node = createTaskCard(card, handlers.onCardClick);
				scroll.appendChild(node);
			}
			mounted.set(card.id, { el: node, signature });
			// Keep mounted order aligned with the model.
			if (scroll.children[i] !== node) {
				scroll.insertBefore(node, scroll.children[i] ?? null);
			}
		}
		for (const [id, entry] of mounted) {
			if (!seen.has(id)) {
				entry.el.remove();
				mounted.delete(id);
			}
		}
	}

	update(initial);
	return { element: host, update };
}
