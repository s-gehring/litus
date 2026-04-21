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

	epicNode(): Locator {
		return this.page.locator("#summary");
	}

	aggregationSummary(): Locator {
		return this.page.locator("#summary");
	}

	aggregationBadge(): Locator {
		return this.page.locator("#workflow-status");
	}

	infeasibleNotes(): Locator {
		return this.page.locator("#epic-analysis-notes");
	}

	/**
	 * Approximation of a "partial decomposition" badge — the product does not
	 * expose an explicit partial marker; we surface the analyzer notes (which
	 * the scenario uses to describe the remaining unspecified scope) as the
	 * observable signal. Tests should assert textual content that the scenario
	 * author chose for the partial case.
	 */
	partialBadge(): Locator {
		return this.page.locator("#epic-analysis-notes");
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

	/** Clicking a child row opens its workflow card. */
	startButton(workflowId: string): Locator {
		return this.childRow(workflowId);
	}

	prLink(): Locator {
		return this.page.locator('a[href*="/pull/"], a.pr-link').first();
	}
}
