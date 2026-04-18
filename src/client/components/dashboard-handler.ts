import type { RouteHandler } from "../router";
import { showDashboardLayout, showFullPageLayout } from "./detail-layout";

/**
 * Dashboard route handler — mounts `#card-strip` and `#welcome-area`, hides
 * `#detail-area`. Layout chrome for the three top-level containers is owned by
 * `detail-layout.ts`; this handler only delegates to those helpers so that
 * adding a fourth top-level view does not require editing this file.
 */
export function createDashboardHandler(): RouteHandler {
	return {
		mount() {
			showDashboardLayout();
		},
		unmount() {
			// Hide every top-level container the dashboard manages so any follow-up
			// handler starts from a clean slate. The next handler's mount will
			// un-hide whatever it owns (see detail-layout.ts).
			showFullPageLayout();
		},
	};
}
