import { hideAskAnswerPanel } from "./ask-answer-panel";
import { hideEpicFeedbackPanel } from "./epic-feedback-panel";
import { hideFeedbackPanel } from "./feedback-panel";
import { hideQuestion } from "./question-panel";

/**
 * Layout chrome for the three top-level views (dashboard, detail, config).
 *
 * These helpers own the show/hide state of `#card-strip`, `#welcome-area` and
 * `#detail-area`. Route handlers call one of the `show*Layout()` entry points on
 * mount so no handler has to know about sibling containers — adding a fourth
 * view only requires a new helper here, not edits to the others.
 */

function setHidden(id: string, hidden: boolean): void {
	const el = document.getElementById(id);
	if (!el) return;
	el.classList.toggle("hidden", hidden);
}

/**
 * Detail view layout: cards + detail visible, welcome hidden. Used by the
 * workflow-detail and epic-detail handlers.
 */
export function showDetailLayout(): void {
	setHidden("card-strip", false);
	setHidden("welcome-area", true);
	setHidden("detail-area", false);
}

/**
 * Tear down the detail view without touching cards or welcome — the next
 * mounted handler picks its own layout state via one of the `show*Layout()`
 * helpers.
 */
export function hideDetailLayout(): void {
	setHidden("detail-area", true);
	const outputArea = document.getElementById("output-area");
	if (outputArea) outputArea.classList.remove("epic-tree-fullsize");
	hideQuestion();
	hideFeedbackPanel();
	hideEpicFeedbackPanel();
	const detailArea = document.getElementById("detail-area");
	if (detailArea) hideAskAnswerPanel(detailArea);
}

/**
 * Dashboard layout: cards + welcome visible, detail hidden. Used by the
 * dashboard route handler.
 */
export function showDashboardLayout(): void {
	setHidden("card-strip", false);
	setHidden("welcome-area", false);
	setHidden("detail-area", true);
}

/**
 * Full-page layout (e.g. `/config`): every other top-level container is hidden
 * so the mounting handler's own DOM fills `#app-content`.
 */
export function showFullPageLayout(): void {
	setHidden("card-strip", true);
	setHidden("welcome-area", true);
	setHidden("detail-area", true);
}
