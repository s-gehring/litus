import type { RouteHandler } from "../router";

export function createDashboardHandler(): RouteHandler {
	return {
		mount() {
			const cardStrip = document.getElementById("card-strip");
			const welcomeArea = document.getElementById("welcome-area");
			const detailArea = document.getElementById("detail-area");
			if (cardStrip) cardStrip.classList.remove("hidden");
			if (welcomeArea) welcomeArea.classList.remove("hidden");
			if (detailArea) detailArea.classList.add("hidden");
		},
		unmount() {
			const cardStrip = document.getElementById("card-strip");
			const welcomeArea = document.getElementById("welcome-area");
			if (cardStrip) cardStrip.classList.add("hidden");
			if (welcomeArea) welcomeArea.classList.add("hidden");
		},
	};
}
