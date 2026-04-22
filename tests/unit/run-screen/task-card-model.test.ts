import { describe, expect, it } from "bun:test";
import { projectTaskCards } from "../../../src/client/components/run-screen/task-card-model";
import { EPIC_CARD_PREFIX } from "../../../src/client/components/status-maps";
import type { EpicAggregatedState, EpicClientState, WorkflowClientState } from "../../../src/types";
import { makeWorkflowState } from "../../helpers";

function wfEntry(
	id: string,
	over: Partial<WorkflowClientState["state"]> = {},
): WorkflowClientState {
	return {
		state: makeWorkflowState({ id, ...over }),
		outputLines: [],
	};
}

function agg(epicId: string, over: Partial<EpicAggregatedState> = {}): EpicAggregatedState {
	return {
		epicId,
		title: `Epic ${epicId}`,
		status: "running",
		progress: { completed: 2, total: 5 },
		startDate: new Date().toISOString(),
		activeWorkMs: 0,
		activeWorkStartedAt: null,
		childWorkflowIds: [],
		...over,
	};
}

function analysis(epicId: string, over: Partial<EpicClientState> = {}): EpicClientState {
	return {
		epicId,
		description: `analysing ${epicId}`,
		status: "analyzing",
		title: null,
		workflowIds: [],
		startedAt: new Date().toISOString(),
		completedAt: null,
		errorMessage: null,
		infeasibleNotes: null,
		analysisSummary: null,
		outputLines: [],
		...over,
	};
}

describe("projectTaskCards", () => {
	it("projects a plain workflow entry into a task card with its id as routeId", () => {
		const entry = wfEntry("wf-1", { workflowKind: "quick-fix", summary: "Fix bug" });
		const cards = projectTaskCards(
			["wf-1"],
			new Map([["wf-1", entry]]),
			new Map(),
			new Map(),
			"wf-1",
		);
		expect(cards.length).toBe(1);
		expect(cards[0].id).toBe("wf-1");
		expect(cards[0].routeId).toBe("wf-1");
		expect(cards[0].type).toBe("quickfix");
		expect(cards[0].selected).toBe(true);
		expect(cards[0].title).toBe("Fix bug");
	});

	it("spec workflow → spec type", () => {
		const entry = wfEntry("wf-2", { workflowKind: "spec" });
		const [card] = projectTaskCards(
			["wf-2"],
			new Map([["wf-2", entry]]),
			new Map(),
			new Map(),
			null,
		);
		expect(card.type).toBe("spec");
	});

	it("epic aggregate → epic card with branchProgress and prefixed id", () => {
		const epicId = "ep-100";
		const [card] = projectTaskCards(
			[`${EPIC_CARD_PREFIX}${epicId}`],
			new Map(),
			new Map(),
			new Map([[epicId, agg(epicId)]]),
			epicId,
		);
		expect(card.type).toBe("epic");
		expect(card.id).toBe(`${EPIC_CARD_PREFIX}${epicId}`);
		expect(card.routeId).toBe(epicId);
		expect(card.branchProgress).toEqual({ done: 2, total: 5 });
		expect(card.state).toBe("running");
		expect(card.selected).toBe(true);
	});

	it("epic analysis entry → epic card with Analyzing step + running state", () => {
		const epicId = "ep-200";
		const [card] = projectTaskCards(
			[epicId],
			new Map(),
			new Map([[epicId, analysis(epicId, { title: "My epic" })]]),
			new Map(),
			null,
		);
		expect(card.type).toBe("epic");
		expect(card.currentStep).toBe("Analyzing");
		expect(card.state).toBe("running");
		expect(card.title).toBe("My epic");
	});

	it("unknown ids are skipped (not present in any store)", () => {
		const cards = projectTaskCards(["missing"], new Map(), new Map(), new Map(), null);
		expect(cards).toEqual([]);
	});

	it("activeRouteId mismatch → selected=false for all", () => {
		const entry = wfEntry("wf-3");
		const [card] = projectTaskCards(
			["wf-3"],
			new Map([["wf-3", entry]]),
			new Map(),
			new Map(),
			"something-else",
		);
		expect(card.selected).toBe(false);
	});

	it("preserves the supplied cardOrder", () => {
		const a = wfEntry("wf-a");
		const b = wfEntry("wf-b");
		const cards = projectTaskCards(
			["wf-b", "wf-a"],
			new Map([
				["wf-a", a],
				["wf-b", b],
			]),
			new Map(),
			new Map(),
			null,
		);
		expect(cards.map((c) => c.id)).toEqual(["wf-b", "wf-a"]);
	});
});
