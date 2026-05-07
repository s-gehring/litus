import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "../happydom";
import { renderCardStrip } from "../../src/client/components/workflow-cards";
import type { EpicAggregatedState, EpicClientState, WorkflowClientState } from "../../src/types";
import { makePersistedEpic } from "../test-infra/factories";

const LONG_DESC =
	"This is a really long epic description that the user pasted into the form and that " +
	"keeps going and going far beyond the visible width of any reasonable card placeholder " +
	"so it absolutely must be truncated before the LLM-generated title arrives.";

function makeAnalyzingEpic(description: string): EpicClientState {
	const persisted = makePersistedEpic({
		epicId: "epic-analyzing",
		status: "analyzing",
		title: null,
		description,
		completedAt: null,
		analysisSummary: null,
	});
	return { ...persisted, outputLines: [] };
}

describe("epic analysis card placeholder summary", () => {
	beforeEach(() => {
		document.body.innerHTML = '<div id="card-strip"></div>';
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	test("truncates long user-input description while LLM title is pending", () => {
		const epic = makeAnalyzingEpic(LONG_DESC);
		const epics = new Map<string, EpicClientState>([[epic.epicId, epic]]);
		const workflows = new Map<string, WorkflowClientState>();
		const aggregates = new Map<string, EpicAggregatedState>();

		renderCardStrip([epic.epicId], workflows, epics, aggregates, null, () => {});

		const summary = document.querySelector(".card-summary");
		const text = summary?.textContent ?? "";
		expect(text.length).toBeGreaterThan(0);
		expect(text.length).toBeLessThanOrEqual(80);
		expect(text.endsWith("…")).toBe(true);
		expect(text).not.toBe(LONG_DESC);
	});

	test("uses LLM title verbatim once analysis produces it", () => {
		const epic: EpicClientState = {
			...makeAnalyzingEpic(LONG_DESC),
			title: "Refactor billing pipeline",
		};
		const epics = new Map<string, EpicClientState>([[epic.epicId, epic]]);
		renderCardStrip([epic.epicId], new Map(), epics, new Map(), null, () => {});

		const summary = document.querySelector(".card-summary");
		expect(summary?.textContent).toBe("Refactor billing pipeline");
	});
});
