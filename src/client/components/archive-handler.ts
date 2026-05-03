import type { ClientMessage, ServerMessage } from "../../protocol";
import type { EpicClientState, PersistedEpic, WorkflowState } from "../../types";
import type { ClientStateManager } from "../client-state-manager";
import type { RouteHandler } from "../router";
import { shortenSummary } from "../short-summary";
import { showFullPageLayout } from "./detail-layout";

export interface ArchiveHandlerDeps {
	getState: () => ClientStateManager;
	send: (msg: ClientMessage) => void;
	navigate: (path: string) => void;
}

type TopLevelEntry =
	| { kind: "epic"; epic: PersistedEpic; children: WorkflowState[] }
	| { kind: "workflow"; workflow: WorkflowState }
	| { kind: "quickfix"; workflow: WorkflowState };

/**
 * Project `ClientStateManager` state onto the archive-page shape defined in
 * data-model.md § "Derived view".
 */
export function buildArchiveProjection(state: ClientStateManager): TopLevelEntry[] {
	const archivedEpics = new Map<string, EpicClientState>();
	for (const [id, epic] of state.getEpics()) {
		if (epic.archived) archivedEpics.set(id, epic);
	}

	const archivedWorkflows: WorkflowState[] = [];
	for (const [, entry] of state.getWorkflows()) {
		if (entry.state.archived) archivedWorkflows.push(entry.state);
	}

	const childrenByEpic = new Map<string, WorkflowState[]>();
	const topLevelWorkflows: WorkflowState[] = [];
	for (const wf of archivedWorkflows) {
		if (wf.epicId && archivedEpics.has(wf.epicId)) {
			const arr = childrenByEpic.get(wf.epicId) ?? [];
			arr.push(wf);
			childrenByEpic.set(wf.epicId, arr);
		} else if (wf.epicId === null) {
			topLevelWorkflows.push(wf);
		}
	}

	const entries: TopLevelEntry[] = [];
	for (const [epicId, epic] of archivedEpics) {
		const kids = childrenByEpic.get(epicId) ?? [];
		// Order children by epic.workflowIds; fall back to createdAt asc for any not listed.
		const orderMap = new Map(epic.workflowIds.map((id, idx) => [id, idx]));
		kids.sort((a, b) => {
			const ia = orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
			const ib = orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
			if (ia !== ib) return ia - ib;
			return a.createdAt.localeCompare(b.createdAt);
		});
		entries.push({ kind: "epic", epic, children: kids });
	}
	for (const wf of topLevelWorkflows) {
		entries.push({
			kind: wf.workflowKind === "quick-fix" ? "quickfix" : "workflow",
			workflow: wf,
		});
	}

	entries.sort((a, b) => {
		const aAt = a.kind === "epic" ? a.epic.archivedAt : a.workflow.archivedAt;
		const bAt = b.kind === "epic" ? b.epic.archivedAt : b.workflow.archivedAt;
		return (bAt ?? "").localeCompare(aAt ?? "");
	});
	return entries;
}

export function createArchiveHandler(deps: ArchiveHandlerDeps): RouteHandler {
	let mounted = false;
	// Ids currently rendered in the archive projection. Used by `onMessage` to
	// skip full re-renders for `workflow:state` deltas that cannot affect the
	// projection (non-archived workflows that were already not in the list).
	const renderedWorkflowIds = new Set<string>();

	function typeCue(kind: "epic" | "spec" | "quickfix"): HTMLElement {
		const cue = document.createElement("span");
		cue.className = `archive-type-cue archive-type-${kind}`;
		cue.textContent = kind === "epic" ? "Epic" : kind === "spec" ? "Spec" : "Fix";
		return cue;
	}

	function renderWorkflowRow(
		wf: WorkflowState,
		opts: { isChild?: boolean; showUnarchive?: boolean; kind?: "spec" | "quickfix" },
	): HTMLElement {
		const row = document.createElement("div");
		row.className = `archive-row${opts.isChild ? " is-child-of-epic" : ""}`;
		row.dataset.workflowId = wf.id;

		const kind = opts.kind ?? (wf.workflowKind === "quick-fix" ? "quickfix" : "spec");
		row.appendChild(typeCue(kind));

		const summary = document.createElement("span");
		summary.className = "archive-summary";
		summary.textContent = wf.summary || shortenSummary(wf.specification);
		row.appendChild(summary);

		const date = document.createElement("span");
		date.className = "archive-date";
		date.textContent = wf.archivedAt ? new Date(wf.archivedAt).toLocaleString() : "";
		row.appendChild(date);

		if (opts.showUnarchive) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "btn-secondary archive-unarchive-btn";
			btn.textContent = "Unarchive";
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				deps.send({ type: "workflow:unarchive", workflowId: wf.id });
			});
			row.appendChild(btn);
		}
		return row;
	}

	function renderEpicRow(epic: PersistedEpic): HTMLElement {
		const row = document.createElement("div");
		row.className = "archive-row";
		row.dataset.epicId = epic.epicId;

		row.appendChild(typeCue("epic"));

		const summary = document.createElement("span");
		summary.className = "archive-summary";
		summary.textContent = epic.title ?? epic.description;
		row.appendChild(summary);

		const date = document.createElement("span");
		date.className = "archive-date";
		date.textContent = epic.archivedAt ? new Date(epic.archivedAt).toLocaleString() : "";
		row.appendChild(date);

		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "btn-secondary archive-unarchive-btn";
		btn.textContent = "Unarchive";
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			deps.send({ type: "epic:unarchive", epicId: epic.epicId });
		});
		row.appendChild(btn);
		return row;
	}

	function render(): void {
		const container = document.getElementById("app-content");
		if (!container) return;
		showFullPageLayout();

		let list = document.getElementById("archive-list");
		if (!list) {
			list = document.createElement("div");
			list.id = "archive-list";
			list.className = "archive-list";
			container.appendChild(list);
		}
		const fragment = document.createDocumentFragment();
		const entries = buildArchiveProjection(deps.getState());
		renderedWorkflowIds.clear();
		for (const entry of entries) {
			if (entry.kind === "epic") {
				for (const child of entry.children) renderedWorkflowIds.add(child.id);
			} else {
				renderedWorkflowIds.add(entry.workflow.id);
			}
		}
		if (entries.length === 0) {
			const empty = document.createElement("div");
			empty.className = "archive-empty";
			empty.textContent = "No archived items yet.";
			fragment.appendChild(empty);
		} else {
			for (const entry of entries) {
				if (entry.kind === "epic") {
					const group = document.createElement("div");
					group.className = "archive-epic-group";
					group.appendChild(renderEpicRow(entry.epic));
					for (const child of entry.children) {
						group.appendChild(renderWorkflowRow(child, { isChild: true, kind: "spec" }));
					}
					fragment.appendChild(group);
				} else {
					fragment.appendChild(
						renderWorkflowRow(entry.workflow, {
							showUnarchive: true,
							kind: entry.kind === "quickfix" ? "quickfix" : "spec",
						}),
					);
				}
			}
		}
		list.replaceChildren(fragment);
	}

	return {
		mount() {
			mounted = true;
			render();
		},
		unmount() {
			mounted = false;
			const list = document.getElementById("archive-list");
			if (list) list.remove();
		},
		onMessage(msg: ServerMessage) {
			if (!mounted) return;
			// Skip `workflow:state` deltas that cannot affect the archive projection:
			// a non-archived workflow whose `archived` field has not flipped from
			// true to false (i.e. it was never in the archive to begin with).
			if (msg.type === "workflow:state") {
				const wf = msg.workflow;
				if (!wf) return;
				// Unchanged projection: non-archived workflow that wasn't rendered.
				if (!wf.archived && !renderedWorkflowIds.has(wf.id)) return;
				render();
				return;
			}
			if (msg.type === "workflow:list" || msg.type === "epic:list" || msg.type === "epic:result") {
				render();
			}
		},
	};
}
