// ── Per-aspect grid panel ─────────────────────────────────
//
// Renders the multi-stream grid for the `research-aspect` step of an
// ask-question workflow. Mounted by `workflow-detail-handler` when the
// current selected step is `research-aspect`. Panels render in fixed
// manifest order (FR-004 / clarification Q3) — never re-shuffled by status.
//
// Live updates: the parent handler calls `applyAspectStateUpdate` when a
// `workflow:aspect:state` arrives, and `applyAspectOutputDelta` /
// `applyAspectToolsDelta` for the streaming channels. These functions
// update only the affected panel rather than re-rendering the entire grid.

import { computeAspectProgress, formatAspectProgressLine } from "../../aspect-researcher";
import type { AspectState, OutputEntry, ToolUsage, WorkflowState } from "../../types";
import { renderToolIcons } from "./workflow-window";

const GRID_ROOT_ID = "aspect-grid-root";
const PROGRESS_LINE_ID = "aspect-grid-progress";
const PANEL_PREFIX = "aspect-panel-";
const PANEL_OUTPUT_PREFIX = "aspect-panel-output-";
const PANEL_STATUS_PREFIX = "aspect-panel-status-";

/**
 * Mount the grid into `container`. Idempotent: if a grid for the same workflow
 * already exists, re-renders all panel content (used after a `workflow:state`
 * snapshot or refresh restoration). Subsequent in-flight updates should use
 * the dedicated delta helpers below.
 */
export function renderAspectGridPanel(container: HTMLElement, workflow: WorkflowState): void {
	const aspects = workflow.aspects ?? [];
	const manifest = workflow.aspectManifest;

	let root = container.querySelector<HTMLElement>(`#${GRID_ROOT_ID}`);
	if (!root) {
		root = document.createElement("div");
		root.id = GRID_ROOT_ID;
		root.className = "aspect-grid-root";
		container.appendChild(root);
	}

	const progress = computeAspectProgress(aspects);
	const headlineText = formatAspectProgressLine(progress);

	const progressLine = ensureProgressLine(root);
	progressLine.textContent = headlineText;

	let grid = root.querySelector<HTMLElement>(".aspect-grid");
	if (!grid) {
		grid = document.createElement("div");
		grid.className = "aspect-grid";
		root.appendChild(grid);
	}

	// Idempotent re-render: leave existing panels alone and update them in place
	// (preserves scroll position and avoids reflow when a coarse `workflow:state`
	// triggers a full re-render mid-stream). Panels for aspects that no longer
	// exist are removed; new aspects are appended in manifest order.
	const seen = new Set<string>();
	for (let i = 0; i < aspects.length; i++) {
		const aspect = aspects[i];
		const title = manifest?.aspects[i]?.title ?? aspect.id;
		seen.add(aspect.id);
		const existing = grid.querySelector<HTMLElement>(`#${PANEL_PREFIX}${cssId(aspect.id)}`);
		if (existing) {
			applyAspectStateUpdate(grid, aspect);
		} else {
			grid.appendChild(renderPanel(aspect, title));
		}
	}
	for (const panel of Array.from(grid.querySelectorAll<HTMLElement>(".aspect-panel"))) {
		const id = panel.id.startsWith(PANEL_PREFIX) ? panel.id.slice(PANEL_PREFIX.length) : "";
		if (id && !seen.has(id)) panel.remove();
	}
}

/** Remove the grid from `container` (used when leaving the research-aspect step). */
export function hideAspectGridPanel(container: HTMLElement): void {
	const root = container.querySelector(`#${GRID_ROOT_ID}`);
	if (root) root.remove();
}

/** Append a streaming text delta to the targeted aspect's panel. */
export function applyAspectOutputDelta(
	container: HTMLElement,
	aspectId: string,
	text: string,
): void {
	const out = container.querySelector<HTMLElement>(`#${PANEL_OUTPUT_PREFIX}${cssId(aspectId)}`);
	if (!out) return;
	const span = document.createElement("span");
	span.className = "aspect-text";
	span.textContent = text;
	out.appendChild(span);
	scrollToBottom(out);
}

/** Append tool-usage icons to the targeted aspect's panel. Rendered inline so
 * they sit alongside surrounding text deltas rather than each occupying their
 * own line — matching the main output-log convention. */
export function applyAspectToolsDelta(
	container: HTMLElement,
	aspectId: string,
	tools: ToolUsage[],
): void {
	const out = container.querySelector<HTMLElement>(`#${PANEL_OUTPUT_PREFIX}${cssId(aspectId)}`);
	if (!out) return;
	out.appendChild(renderToolIcons(tools));
	scrollToBottom(out);
}

/**
 * Replace the targeted aspect's panel content with `state`. Called from the
 * `workflow:aspect:state` reducer; also drives the wipe-on-retry behaviour
 * (the orchestrator broadcasts a wiped state with empty outputLog before
 * re-dispatching, and the panel resets accordingly).
 */
export function applyAspectStateUpdate(container: HTMLElement, aspect: AspectState): void {
	const panel = container.querySelector<HTMLElement>(`#${PANEL_PREFIX}${cssId(aspect.id)}`);
	if (!panel) return;
	const status = panel.querySelector<HTMLElement>(`#${PANEL_STATUS_PREFIX}${cssId(aspect.id)}`);
	if (status) {
		status.textContent = aspect.status;
		status.className = `aspect-panel-status status-${aspect.status}`;
	}
	const out = panel.querySelector<HTMLElement>(`#${PANEL_OUTPUT_PREFIX}${cssId(aspect.id)}`);
	if (out) {
		out.innerHTML = "";
		renderEntries(out, aspect.outputLog);
	}
	if (aspect.status === "errored" && aspect.errorMessage) {
		const errLine = document.createElement("div");
		errLine.className = "aspect-error-line";
		errLine.textContent = aspect.errorMessage;
		panel.appendChild(errLine);
	} else {
		for (const n of panel.querySelectorAll(".aspect-error-line")) {
			n.remove();
		}
	}
}

/** Update only the progress header (FR-006). */
export function updateAspectProgressLine(container: HTMLElement, workflow: WorkflowState): void {
	const root = container.querySelector<HTMLElement>(`#${GRID_ROOT_ID}`);
	if (!root) return;
	const progressLine = ensureProgressLine(root);
	progressLine.textContent = formatAspectProgressLine(
		computeAspectProgress(workflow.aspects ?? []),
	);
}

// Internals ------------------------------------------------

function ensureProgressLine(root: HTMLElement): HTMLElement {
	let line = root.querySelector<HTMLElement>(`#${PROGRESS_LINE_ID}`);
	if (!line) {
		line = document.createElement("div");
		line.id = PROGRESS_LINE_ID;
		line.className = "aspect-progress";
		root.insertBefore(line, root.firstChild);
	}
	return line;
}

function renderPanel(aspect: AspectState, title: string): HTMLElement {
	const panel = document.createElement("div");
	panel.id = `${PANEL_PREFIX}${cssId(aspect.id)}`;
	panel.className = "aspect-panel";

	const header = document.createElement("div");
	header.className = "aspect-panel-header";

	const titleEl = document.createElement("span");
	titleEl.className = "aspect-panel-title";
	titleEl.textContent = title;
	header.appendChild(titleEl);

	const statusEl = document.createElement("span");
	statusEl.id = `${PANEL_STATUS_PREFIX}${cssId(aspect.id)}`;
	statusEl.className = `aspect-panel-status status-${aspect.status}`;
	statusEl.textContent = aspect.status;
	header.appendChild(statusEl);

	panel.appendChild(header);

	const out = document.createElement("div");
	out.id = `${PANEL_OUTPUT_PREFIX}${cssId(aspect.id)}`;
	out.className = "aspect-panel-output";
	renderEntries(out, aspect.outputLog);
	panel.appendChild(out);

	if (aspect.status === "errored" && aspect.errorMessage) {
		const errLine = document.createElement("div");
		errLine.className = "aspect-error-line";
		errLine.textContent = aspect.errorMessage;
		panel.appendChild(errLine);
	}

	return panel;
}

function renderEntries(out: HTMLElement, entries: OutputEntry[]): void {
	for (const entry of entries) {
		if (entry.kind === "text") {
			const span = document.createElement("span");
			span.className = "aspect-text";
			span.textContent = entry.text;
			out.appendChild(span);
		} else {
			out.appendChild(renderToolIcons(entry.tools));
		}
	}
	scrollToBottom(out);
}

/** Sanitise an aspect id for use as a DOM id fragment. Aspect ids are already
 * constrained to `^[a-zA-Z0-9_-]+$` by `validateAspectManifest`, so this is a
 * defensive pass-through. */
function cssId(aspectId: string): string {
	return aspectId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function scrollToBottom(el: HTMLElement): void {
	el.scrollTop = el.scrollHeight;
}

/**
 * Render the collapsed-summary line shown after the workflow advances past
 * `research-aspect` (FR-007).
 */
export function renderAspectSummaryLine(container: HTMLElement, count: number): void {
	hideAspectGridPanel(container);
	const root = document.createElement("div");
	root.id = GRID_ROOT_ID;
	root.className = "aspect-grid-summary";
	root.textContent = `Researched ${count} aspects — see artifacts`;
	container.appendChild(root);
}
