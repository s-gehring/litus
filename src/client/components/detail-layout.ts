import { hideFeedbackPanel } from "./feedback-panel";
import { hideQuestion } from "./question-panel";

export function showDetailLayout(): void {
	const cardStrip = document.getElementById("card-strip");
	const welcomeArea = document.getElementById("welcome-area");
	const detailArea = document.getElementById("detail-area");
	if (cardStrip) cardStrip.classList.remove("hidden");
	if (welcomeArea) welcomeArea.classList.add("hidden");
	if (detailArea) detailArea.classList.remove("hidden");
}

export function hideDetailLayout(): void {
	const detailArea = document.getElementById("detail-area");
	if (detailArea) detailArea.classList.add("hidden");
	const outputArea = document.getElementById("output-area");
	if (outputArea) outputArea.classList.remove("epic-tree-fullsize");
	hideQuestion();
	hideFeedbackPanel();
}
