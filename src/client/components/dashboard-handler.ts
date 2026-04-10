import type { RouteHandler } from "../router";

export function createDashboardHandler(): RouteHandler {
	return {
		mount(_container: HTMLElement) {
			const cardStrip = document.getElementById("card-strip");
			const welcomeArea = document.getElementById("welcome-area");
			if (cardStrip) cardStrip.classList.remove("hidden");
			if (welcomeArea) welcomeArea.classList.remove("hidden");
			// detail-area visibility is managed by renderExpandedView
		},
		unmount() {
			const cardStrip = document.getElementById("card-strip");
			const welcomeArea = document.getElementById("welcome-area");
			const detailArea = document.getElementById("detail-area");
			if (cardStrip) cardStrip.classList.add("hidden");
			if (welcomeArea) welcomeArea.classList.add("hidden");
			if (detailArea) detailArea.classList.add("hidden");
		},
	};
}
