import type { RouteHandler } from "../router";
import { showDashboardLayout, showFullPageLayout } from "./detail-layout";
import { createWelcomeEmptyState } from "./run-screen/welcome-empty-state";

/**
 * Dashboard route handler — mounts `#card-strip` and `#welcome-area`, hides
 * `#detail-area`. Layout chrome for the three top-level containers is owned by
 * `detail-layout.ts`; this handler only delegates to those helpers so that
 * adding a fourth top-level view does not require editing this file. The
 * welcome area renders the redesigned LITUS empty state while the legacy
 * inline welcome-text paragraph stays hidden.
 */
export function createDashboardHandler(): RouteHandler {
	let welcome: HTMLElement | null = null;

	function showRedesignedWelcome(): void {
		const area = document.getElementById("welcome-area");
		if (!area) return;
		const legacyText = area.querySelector<HTMLElement>(".welcome-text");
		if (legacyText) legacyText.classList.add("hidden");
		if (!welcome) {
			welcome = createWelcomeEmptyState().element;
			area.appendChild(welcome);
		}
	}

	function hideRedesignedWelcome(): void {
		if (welcome) {
			welcome.remove();
			welcome = null;
		}
	}

	return {
		mount() {
			showDashboardLayout();
			showRedesignedWelcome();
		},
		unmount() {
			hideRedesignedWelcome();
			showFullPageLayout();
		},
	};
}
