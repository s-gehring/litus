// CI Pipeline Status View — icon row above #output-log on the monitor-ci step.
//
// Pure DOM module. Reads `WorkflowState.ciCycle.lastCheckResults` and
// `ciCycle.attempt` from the snapshot the workflow-detail-handler hands in;
// does not subscribe to the WebSocket and does not touch `window`-scoped
// state (B-10).
//
// Public surface — see `specs/001-ci-pipeline-status-view/contracts/ui-component-contract.md`.
// Data model — see `specs/001-ci-pipeline-status-view/data-model.md`.

import { STEP } from "../../pipeline-steps";
import type { CiCheckResult, WorkflowState } from "../../types";

type WorkflowStep = WorkflowState["steps"][number];
type StepStatus = WorkflowStep["status"];

const ROOT_CLASS = "ci-pipeline-status-view";
const ENTRY_CLASS = "ci-entry";
const ENTRY_PULSE_CLASS = "ci-entry-pulse";
const PLACEHOLDER_CLASS = "ci-pipeline-status-placeholder";

type CiStatusCategory = "in_progress" | "succeeded" | "failed" | "cancelled" | "skipped";

interface CiCheckEntry {
	stableKey: string;
	name: string;
	category: CiStatusCategory;
	terminal: boolean;
}

interface ViewState {
	workflowId: string;
	lastSeenAttempt: number;
	slotByKey: Map<string, number>;
	nextSlot: number;
	/**
	 * Snapshot of the last rendered entries (sorted by slot). Used to
	 * support the "transient empty frame" defense (B-8).
	 */
	lastRenderedEntries: CiCheckEntry[];
	/**
	 * Last `ciCycle.pollCount` value carried by a successful render. The
	 * pulse fires only when the value advances, so non-poll
	 * `workflow:state` broadcasts (step transitions, tool deltas, etc.)
	 * don't repulse the row.
	 */
	lastSeenPollCount: number;
}

export interface CiPipelineStatusViewHandle {
	render(workflow: WorkflowState, selectedStepIndex: number): void;
	destroy(): void;
}

export function createCiPipelineStatusView(outputArea: HTMLElement): CiPipelineStatusViewHandle {
	let state: ViewState | null = null;

	function detachDom(): void {
		const root = outputArea.querySelector(`.${ROOT_CLASS}`);
		if (root) root.remove();
	}

	function destroy(): void {
		detachDom();
		state = null;
	}

	function render(workflow: WorkflowState, selectedStepIndex: number): void {
		const step: WorkflowStep | undefined = workflow.steps[selectedStepIndex];
		if (!step || step.name !== STEP.MONITOR_CI) {
			// Step toggle: drop the DOM but preserve the slot cache so
			// re-selecting monitor-ci within the same attempt doesn't
			// re-order entries (FR-003).
			detachDom();
			return;
		}

		// Reset cache on workflow switch or attempt rollover (B-4 / FR-011).
		const attempt = workflow.ciCycle.attempt;
		if (!state || state.workflowId !== workflow.id || state.lastSeenAttempt !== attempt) {
			state = {
				workflowId: workflow.id,
				lastSeenAttempt: attempt,
				slotByKey: new Map(),
				nextSlot: 0,
				lastRenderedEntries: [],
				lastSeenPollCount: workflow.ciCycle.pollCount ?? 0,
			};
		}

		const results = workflow.ciCycle.lastCheckResults;
		const root = ensureRoot(outputArea);
		const stepTerminal = step.status === "completed" || step.status === "error";

		// Defensive empty-frame survival (B-8 / FR-012): if the new poll
		// returns no results but we previously rendered entries within the
		// same attempt, keep the existing icons in place. Skipped once the
		// step itself has terminated — at that point the honest summary is
		// the placeholder, not stale icons.
		if (!stepTerminal && results.length === 0 && state.lastRenderedEntries.length > 0) {
			return;
		}

		const currentPollCount = workflow.ciCycle.pollCount ?? 0;

		if (results.length === 0) {
			renderPlaceholder(root, step.status);
			state.lastSeenPollCount = currentPollCount;
			return;
		}

		const entries = buildOrderedEntries(state, results);

		// Pulse only when a poll has actually completed since the last
		// render (B-6 / FR-008). Non-poll `workflow:state` frames (step
		// transitions, tool deltas, active-model start/end, etc.) leave
		// `pollCount` unchanged and therefore do not repulse the row.
		const pulseNonTerminal =
			state.lastRenderedEntries.length > 0 && currentPollCount > state.lastSeenPollCount;

		renderEntries(root, entries, pulseNonTerminal);
		state.lastRenderedEntries = entries;
		state.lastSeenPollCount = currentPollCount;
	}

	return {
		render,
		destroy,
	};
}

function ensureRoot(outputArea: HTMLElement): HTMLElement {
	let root = outputArea.querySelector<HTMLElement>(`.${ROOT_CLASS}`);
	if (root) {
		// Make sure we stay the first child even if some other render path
		// inserted siblings between us and #output-log (defensive).
		if (outputArea.firstElementChild !== root) {
			outputArea.insertBefore(root, outputArea.firstElementChild);
		}
		return root;
	}
	root = document.createElement("div");
	root.className = ROOT_CLASS;
	outputArea.insertBefore(root, outputArea.firstElementChild);
	return root;
}

function renderPlaceholder(root: HTMLElement, stepStatus: StepStatus): void {
	root.replaceChildren();
	const node = document.createElement("div");
	node.className = PLACEHOLDER_CLASS;
	node.textContent =
		stepStatus === "completed" || stepStatus === "error"
			? "No CI checks were reported."
			: "Waiting for checks…";
	root.appendChild(node);
}

function buildOrderedEntries(state: ViewState, results: CiCheckResult[]): CiCheckEntry[] {
	// Assign first-seen slots; previously-seen keys keep their slot for the
	// duration of the attempt (R-7 / FR-003).
	const sized: { slot: number; entry: CiCheckEntry }[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const stableKey = `${result.name}::${i}`;
		let slot = state.slotByKey.get(stableKey);
		if (slot === undefined) {
			slot = state.nextSlot++;
			state.slotByKey.set(stableKey, slot);
		}
		sized.push({ slot, entry: makeEntry(result, stableKey) });
	}
	sized.sort((a, b) => a.slot - b.slot);
	return sized.map((s) => s.entry);
}

function makeEntry(result: CiCheckResult, stableKey: string): CiCheckEntry {
	const category = bucketToCategory(result.bucket);
	return {
		stableKey,
		name: result.name,
		category,
		terminal: category !== "in_progress",
	};
}

function bucketToCategory(bucket: string): CiStatusCategory {
	switch (bucket) {
		case "pass":
			return "succeeded";
		case "fail":
			return "failed";
		case "cancel":
			return "cancelled";
		case "skipping":
			return "skipped";
		default:
			// "pending" and any unknown bucket fall through to non-terminal
			// in_progress (R-5 safe default).
			return "in_progress";
	}
}

function renderEntries(
	root: HTMLElement,
	entries: CiCheckEntry[],
	pulseNonTerminal: boolean,
): void {
	root.replaceChildren();
	for (const entry of entries) {
		const node = document.createElement("div");
		node.className = `${ENTRY_CLASS} ci-entry-${categoryClass(entry.category)}`;
		if (pulseNonTerminal && !entry.terminal) {
			node.classList.add(ENTRY_PULSE_CLASS);
			// Drop the class on `animationend` so the next poll-driven render
			// can re-trigger the same animation.
			node.addEventListener("animationend", () => node.classList.remove(ENTRY_PULSE_CLASS), {
				once: true,
			});
		}
		node.dataset.stableKey = entry.stableKey;
		const statusLabel = humanizeCategory(entry.category);
		const accessible = `${entry.name} — ${statusLabel}`;
		node.title = accessible;
		node.setAttribute("aria-label", accessible);

		const icon = document.createElement("span");
		icon.className = "ci-entry-icon";
		icon.setAttribute("aria-hidden", "true");
		node.appendChild(icon);

		const label = document.createElement("span");
		label.className = "ci-entry-label";
		label.textContent = entry.name;
		node.appendChild(label);

		root.appendChild(node);
	}
}

function humanizeCategory(category: CiStatusCategory): string {
	switch (category) {
		case "in_progress":
			return "in progress";
		case "succeeded":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "skipped":
			return "skipped";
	}
}

function categoryClass(category: CiStatusCategory): string {
	switch (category) {
		case "in_progress":
			return "in-progress";
		case "succeeded":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "skipped":
			return "skipped";
	}
}
