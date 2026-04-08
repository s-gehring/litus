/** Shorthand for document.querySelector, cast to HTMLElement. */
export const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

/** Create a timer span with data-active-work-* attributes. */
export function createTimerElement(
	activeWorkMs: number,
	activeWorkStartedAt: string | null,
	formatTimer: (ms: number, startedAt: string | null) => string,
	extraClass?: string,
): HTMLSpanElement {
	const timer = document.createElement("span");
	timer.className = extraClass ? `card-timer ${extraClass}` : "card-timer";
	timer.dataset.activeWorkMs = String(activeWorkMs);
	timer.dataset.activeWorkStartedAt = activeWorkStartedAt || "";
	timer.textContent = formatTimer(activeWorkMs, activeWorkStartedAt);
	return timer;
}
