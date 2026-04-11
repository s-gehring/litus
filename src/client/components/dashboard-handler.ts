import type { RouteHandler } from "../router";

export function createDashboardHandler(): RouteHandler {
	let root: HTMLElement | null = null;

	return {
		mount(container: HTMLElement) {
			root = container;
			const cardStrip = container.querySelector<HTMLElement>("#card-strip");
			const welcomeArea = container.querySelector<HTMLElement>("#welcome-area");
			if (cardStrip) cardStrip.classList.remove("hidden");
			if (welcomeArea) welcomeArea.classList.remove("hidden");
			// detail-area visibility is managed by renderExpandedView
		},
		unmount() {
			if (!root) return;
			const cardStrip = root.querySelector<HTMLElement>("#card-strip");
			const welcomeArea = root.querySelector<HTMLElement>("#welcome-area");
			const detailArea = root.querySelector<HTMLElement>("#detail-area");
			if (cardStrip) cardStrip.classList.add("hidden");
			if (welcomeArea) welcomeArea.classList.add("hidden");
			if (detailArea) detailArea.classList.add("hidden");
			root = null;
		},
	};
}
