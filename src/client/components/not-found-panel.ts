/**
 * Dedicated empty-state rendered when a deep link targets a workflow or
 * epic id that does not exist. Distinct from the welcome area so the
 * routing test can assert this case landed on a dedicated "not found" view,
 * not on the root landing state.
 *
 * Mounts into `#app-content` and hides the dashboard chrome while visible;
 * `hideNotFoundPanel` owns restoring whatever it hid so a subsequent
 * navigation to `/` doesn't leave `#card-strip` or `#welcome-area` hidden.
 */
let panel: HTMLElement | null = null;
// Only the welcome area must be hidden — spec FR-008a requires the not-found
// state to read as "distinct from the welcome area". Card strip and detail
// shell stay visible so the user retains the in-progress workflow list and a
// stable layout when deep-linking to a missing id.
const HIDDEN_IDS = ["welcome-area"] as const;
let hiddenByPanel: string[] = [];

export function showNotFoundPanel(kind: "workflow" | "epic", id: string): void {
	hideNotFoundPanel();
	const host = document.getElementById("app-content");
	if (!host) return;

	const container = document.createElement("div");
	container.className = "not-found-panel";
	container.setAttribute("data-testid", "not-found");

	const heading = document.createElement("h2");
	heading.className = "not-found-heading";
	heading.textContent = kind === "workflow" ? "Workflow not found" : "Epic not found";
	container.appendChild(heading);

	const message = document.createElement("p");
	message.className = "not-found-message";
	message.textContent = `No ${kind} with id "${id}" exists. It may have been deleted or the link is incorrect.`;
	container.appendChild(message);

	host.appendChild(container);
	panel = container;

	// Clear any stale pipeline-step rows left over from a previously-selected
	// workflow. The not-found panel sits alongside `#detail-area`, so without
	// this clear a deep link from `/workflow/<real>` to `/workflow/<unknown>`
	// would render the not-found heading next to the prior workflow's step
	// rows.
	const pipelineSteps = document.getElementById("pipeline-steps");
	if (pipelineSteps) pipelineSteps.replaceChildren();

	// Hide the dashboard chrome while the not-found panel is visible so the
	// empty-state owns the viewport. Record which elements we actually hid so
	// `hideNotFoundPanel` only restores those (and doesn't unhide elements
	// that were already hidden for unrelated reasons).
	hiddenByPanel = [];
	for (const elId of HIDDEN_IDS) {
		const el = document.getElementById(elId);
		if (el && !el.classList.contains("hidden")) {
			el.classList.add("hidden");
			hiddenByPanel.push(elId);
		}
	}
}

export function hideNotFoundPanel(): void {
	if (panel) {
		// `isConnected` guard: if a test (or any future caller) re-imports this
		// module the prior render's `panel` reference may point at a node that
		// is no longer in the document. `remove()` on a detached node is a
		// no-op in real browsers but throws in some test DOMs; the guard makes
		// the cleanup idempotent regardless.
		if (panel.isConnected) panel.remove();
		panel = null;
	}
	for (const elId of hiddenByPanel) {
		document.getElementById(elId)?.classList.remove("hidden");
	}
	hiddenByPanel = [];
}
