import { $ } from "../dom";
import { type ConfirmModalOptions, showConfirmModal } from "./confirm-modal";

export const ACTION_SLOTS = ["primary", "secondary", "destructive", "finalize"] as const;
export type ActionSlot = (typeof ACTION_SLOTS)[number];

export type ActionKey =
	| "start"
	| "force-start"
	| "resume"
	| "pause"
	| "retry-step"
	| "provide-feedback"
	| "start-children"
	| "pause-all"
	| "resume-all"
	| "abort-all"
	| "retry-workflow"
	| "abort"
	| "finalize"
	| "archive"
	| "view-archive";

interface ActionRegistryEntry {
	label: string;
	slot: ActionSlot;
	className: string;
	confirm?: ConfirmModalOptions;
}

const ABORT_CONFIRM: ConfirmModalOptions = {
	title: "Abort this workflow?",
	body: "This will stop the workflow at its current step. The branch and worktree are preserved — you can restart later.",
	confirmLabel: "Abort",
	cancelLabel: "Cancel",
};

const ABORT_ALL_CONFIRM: ConfirmModalOptions = {
	title: "Abort every non-terminal child?",
	body: "This stops every paused, waiting, or errored child workflow of the epic. Running children must be paused first. Branches and worktrees are preserved.",
	confirmLabel: "Abort all",
	cancelLabel: "Cancel",
};

const RETRY_WORKFLOW_CONFIRM: ConfirmModalOptions = {
	title: "Restart this workflow?",
	body: "This resets the workflow to Setup and deletes its branch, worktree, and artifacts. Uncommitted changes in the managed worktree will be lost.",
	confirmLabel: "Restart",
	cancelLabel: "Cancel",
};

export const ACTION_REGISTRY: Record<ActionKey, ActionRegistryEntry> = {
	start: { label: "Start", slot: "primary", className: "btn-primary" },
	"force-start": { label: "Force start", slot: "primary", className: "btn-primary" },
	resume: { label: "Resume", slot: "primary", className: "btn-primary" },
	pause: { label: "Pause", slot: "primary", className: "btn-primary" },
	"retry-step": { label: "Retry step", slot: "secondary", className: "btn-secondary" },
	"provide-feedback": {
		label: "Provide feedback",
		slot: "secondary",
		className: "btn-secondary",
	},
	"start-children": {
		label: "Start specs",
		slot: "primary",
		className: "btn-primary",
	},
	"pause-all": { label: "Pause all", slot: "secondary", className: "btn-secondary" },
	"resume-all": { label: "Resume all", slot: "secondary", className: "btn-secondary" },
	"abort-all": {
		label: "Abort all",
		slot: "destructive",
		className: "btn-danger",
		confirm: ABORT_ALL_CONFIRM,
	},
	"retry-workflow": {
		label: "Restart",
		slot: "destructive",
		className: "btn-warning",
		confirm: RETRY_WORKFLOW_CONFIRM,
	},
	abort: {
		label: "Abort",
		slot: "destructive",
		className: "btn-danger",
		confirm: ABORT_CONFIRM,
	},
	finalize: { label: "Finalize", slot: "primary", className: "btn-primary" },
	archive: { label: "Archive", slot: "finalize", className: "btn-secondary" },
	"view-archive": { label: "Open in archive", slot: "finalize", className: "btn-secondary" },
};

export interface ActionSpec {
	key: ActionKey;
	onClick: () => void;
	/**
	 * Optional inline-disabled state. When set, the button renders with
	 * `disabled` attribute, the `btn-disabled` class, the reason as the
	 * `title` tooltip, and click handlers are not attached.
	 */
	disabled?: { reason: string };
	/**
	 * Optional dynamic label override (e.g. `Start 2 specs`, `Starting…`).
	 * The test-id is always derived from the action key, so overriding the
	 * label never changes selectors.
	 */
	labelOverride?: string;
	/**
	 * Optional one-shot loading-state class hook. When true, `btn-loading`
	 * is added so the registry stays free of imperative className strings.
	 * The button is also auto-disabled while loading to prevent re-clicks.
	 */
	loading?: boolean;
	/**
	 * When set, the registry confirm modal is replaced (or added). Use this
	 * sparingly — most confirms should live in the registry. Today's only
	 * caller is the `archive` key, which conditionalises the modal copy on
	 * "non-terminal" vs. "terminal" states.
	 */
	confirmOverride?: ConfirmModalOptions | null;
}

/**
 * Render the detail-action bar from a list of `ActionSpec`s.
 *
 * Buttons are grouped into slots in the order defined by `ACTION_SLOTS`
 * (primary → secondary → destructive → finalize). Within a slot the render
 * order is the *insertion order* of the specs — there is no implicit
 * priority. Callers that care about intra-slot ordering must push the
 * specs in the order they want them rendered.
 */
export function renderDetailActions(specs: ActionSpec[]): void {
	const container = $("#detail-actions");
	container.replaceChildren();

	if (specs.length === 0) {
		container.classList.add("hidden");
		return;
	}

	const grouped = groupBySlot(specs);
	let breakAdded = false;

	for (const slot of ACTION_SLOTS) {
		const isRightSide = slot === "destructive" || slot === "finalize";
		for (const spec of grouped[slot]) {
			const entry = ACTION_REGISTRY[spec.key];
			const btn = document.createElement("button");
			btn.type = "button";

			const isInactive = Boolean(spec.disabled) || Boolean(spec.loading);
			const classes = ["btn", entry.className];
			if (spec.disabled) classes.push("btn-disabled");
			if (spec.loading) classes.push("btn-loading");
			btn.className = classes.join(" ");

			btn.textContent = spec.labelOverride ?? entry.label;
			btn.dataset.testid = `action-${spec.key}`;
			btn.dataset.slot = slot;

			if (isRightSide && !breakAdded) {
				btn.classList.add("slot-break");
				breakAdded = true;
			}

			if (isInactive) {
				btn.disabled = true;
				btn.setAttribute("aria-disabled", "true");
				if (spec.disabled) btn.title = spec.disabled.reason;
			} else {
				const confirm =
					spec.confirmOverride === null ? null : (spec.confirmOverride ?? entry.confirm ?? null);
				btn.addEventListener("click", async () => {
					if (confirm) {
						const ok = await showConfirmModal(confirm);
						if (!ok) return;
					}
					spec.onClick();
				});
			}

			container.appendChild(btn);
		}
	}

	container.classList.remove("hidden");
}

function groupBySlot(specs: ActionSpec[]): Record<ActionSlot, ActionSpec[]> {
	const out: Record<ActionSlot, ActionSpec[]> = {
		primary: [],
		secondary: [],
		destructive: [],
		finalize: [],
	};
	for (const spec of specs) {
		const slot = ACTION_REGISTRY[spec.key].slot;
		out[slot].push(spec);
	}
	return out;
}
