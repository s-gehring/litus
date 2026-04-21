import type { Locator, Page } from "@playwright/test";

/**
 * Page object for the epic tree UI rendered by
 * `src/client/components/epic-tree.ts`. The tree lives inside
 * `.epic-tree-container` and contains a `.tree-node` per child workflow.
 * Empty decompositions render a single `.tree-empty` element instead.
 *
 * The epic detail panel (rendered by `epic-detail-handler.ts`) surfaces the
 * aggregation summary via `#summary`, the status badge via `#workflow-status`,
 * and the analyzer notes via `#epic-analysis-notes`.
 */
export class EpicTree {
	constructor(public readonly page: Page) {}

	container(): Locator {
		return this.page.locator(".epic-tree-container");
	}

	emptyState(): Locator {
		return this.page.locator(".epic-tree-container .tree-empty");
	}

	/**
	 * `#workflow-summary` is the shared summary slot used by both
	 * workflow-detail and epic-detail handlers (see
	 * `workflow-window.ts#updateSummary`). For epics it carries
	 * `${title} (${completed}/${total} completed)` in tree-view and the
	 * epic title/description in analysis-view, so both the "epic node
	 * heading" and the "aggregation summary" are the same element — the
	 * two accessors are aliases to communicate reader intent.
	 */
	epicNode(): Locator {
		return this.page.locator("#workflow-summary");
	}

	aggregationSummary(): Locator {
		return this.page.locator("#workflow-summary");
	}

	aggregationBadge(): Locator {
		return this.page.locator("#workflow-status");
	}

	/**
	 * Analyzer notes surface. Two DOM shapes depending on status:
	 *   - `status === "infeasible"`: tree-view is skipped; notes render as
	 *     `div.epic-analysis-notes.infeasible-notes-fullheight` inside
	 *     `#output-log` (no id, see `renderAnalysisView`).
	 *   - other statuses with analysis notes: tree-view renders a
	 *     `#epic-analysis-notes` container above the tree (see
	 *     `renderEpicAnalysisNotes`).
	 * The combined locator covers both shapes so tests don't have to choose.
	 * Partial decompositions route through the second shape; zero-specs and
	 * pure-infeasible go through the first.
	 */
	infeasibleNotes(): Locator {
		return this.page.locator("#epic-analysis-notes, .infeasible-notes-fullheight");
	}

	analyzerErrorBanner(): Locator {
		// Surface of analyzer errors is the workflow-status badge going into
		// the error state plus the server error alert; the safest signal is
		// the status badge with the `card-status-error` class.
		return this.page.locator("#workflow-status.card-status-error, .alert-error");
	}

	allChildRows(): Locator {
		return this.page.locator(".epic-tree-container .tree-node");
	}

	childRow(workflowId: string): Locator {
		return this.page.locator(`.tree-node[data-workflow-id="${workflowId}"]`);
	}

	childRowByTitle(title: string): Locator {
		return this.page
			.locator(".tree-node")
			.filter({ has: this.page.locator(".tree-node-title", { hasText: title }) });
	}

	childStatus(workflowId: string): Locator {
		return this.childRow(workflowId).locator(".card-status");
	}
}
