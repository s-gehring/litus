import { beforeEach, describe, expect, test } from "bun:test";
import "../happydom";
import { renderEpicTree, updateEpicTreeRow } from "../../src/client/components/epic-tree";
import type { EpicAggregatedState, WorkflowState } from "../../src/types";
import { makeWorkflowState } from "../helpers";

function makeAggregate(overrides: Partial<EpicAggregatedState> = {}): EpicAggregatedState {
	return {
		epicId: "epic-1",
		title: "Test Epic",
		status: "in_progress",
		childWorkflowIds: ["wf-a", "wf-b"],
		progress: { completed: 0, total: 2 },
		startDate: "2026-04-18T00:00:00.000Z",
		activeWorkMs: 0,
		activeWorkStartedAt: null,
		...overrides,
	};
}

describe("updateEpicTreeRow", () => {
	let container: HTMLElement;

	beforeEach(() => {
		document.body.innerHTML = `<div id="host"></div>`;
		container = document.getElementById("host") as HTMLElement;
	});

	test("updates a matching node's status badge in place without re-rendering siblings", () => {
		const wfA = makeWorkflowState({ id: "wf-a", summary: "A", status: "running" });
		const wfB = makeWorkflowState({ id: "wf-b", summary: "B", status: "idle" });
		const workflows = new Map<string, WorkflowState>([
			[wfA.id, wfA],
			[wfB.id, wfB],
		]);

		const tree = renderEpicTree(makeAggregate(), workflows, () => {});
		container.appendChild(tree);

		const siblingBefore = tree.querySelector<HTMLElement>('.tree-node[data-workflow-id="wf-b"]');
		expect(siblingBefore).not.toBeNull();

		const badgeBeforeText = tree
			.querySelector<HTMLElement>('.tree-node[data-workflow-id="wf-a"] .card-status')
			?.textContent?.toLowerCase();
		const updatedA: WorkflowState = { ...wfA, status: "completed" };
		const ok = updateEpicTreeRow(tree, "wf-a", updatedA);
		expect(ok).toBe(true);

		const nodeA = tree.querySelector<HTMLElement>('.tree-node[data-workflow-id="wf-a"]');
		const badgeAfterText = nodeA?.querySelector(".card-status")?.textContent;
		expect(badgeAfterText).toBeTruthy();
		// The status label changed from whatever "running" rendered as to the
		// "completed" label — proves the badge was rewritten in place.
		expect(badgeAfterText).not.toBe(badgeBeforeText);

		// Sibling is the exact same DOM node — proves it was not re-rendered.
		const siblingAfter = tree.querySelector<HTMLElement>('.tree-node[data-workflow-id="wf-b"]');
		expect(siblingAfter).toBe(siblingBefore);
	});

	test("returns false when the workflow id is not present in the tree", () => {
		const wfA = makeWorkflowState({ id: "wf-a", summary: "A", status: "running" });
		const workflows = new Map<string, WorkflowState>([[wfA.id, wfA]]);

		const tree = renderEpicTree(makeAggregate({ childWorkflowIds: ["wf-a"] }), workflows, () => {});
		container.appendChild(tree);

		const missing = makeWorkflowState({ id: "wf-new", summary: "New", status: "idle" });
		const ok = updateEpicTreeRow(tree, "wf-new", missing);
		expect(ok).toBe(false);
	});
});
