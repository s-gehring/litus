import { describe, expect, test } from "bun:test";
import { ClientStateManager } from "../../src/client/client-state-manager";
import {
	BACK_TO_EPIC_FALLBACK_TITLE,
	BACK_TO_EPIC_PREFIX,
	backToEpicLabel,
} from "../../src/client/components/back-to-epic-label";
import { makeWorkflowState } from "../helpers";
import { makePersistedEpic } from "../test-infra/factories";

describe("backToEpicLabel", () => {
	test("prefers aggregate title when a child workflow exists for the epic", () => {
		const mgr = new ClientStateManager();
		mgr.handleMessage({
			type: "workflow:list",
			workflows: [
				makeWorkflowState({
					id: "child-1",
					epicId: "epic-42",
					epicTitle: "Aggregate Title",
					status: "completed",
				}),
			],
		});
		expect(backToEpicLabel("epic-42", mgr)).toBe("Aggregate Title");
	});

	test("falls back to the epic analysis title when no aggregate exists", () => {
		const mgr = new ClientStateManager();
		mgr.handleMessage({
			type: "epic:list",
			epics: [
				makePersistedEpic({
					epicId: "epic-solo",
					title: "Analysis Only Title",
					status: "completed",
				}),
			],
		});
		expect(backToEpicLabel("epic-solo", mgr)).toBe("Analysis Only Title");
	});

	test("falls back to the literal 'epic' when neither map has the epic", () => {
		const mgr = new ClientStateManager();
		expect(backToEpicLabel("epic-missing", mgr)).toBe(BACK_TO_EPIC_FALLBACK_TITLE);
	});

	test("prefix constant is the arrow-plus-space followed by 'Back to '", () => {
		expect(BACK_TO_EPIC_PREFIX).toBe("\u2190 Back to ");
	});

	test("aggregate title wins over analysis title", () => {
		const mgr = new ClientStateManager();
		mgr.handleMessage({
			type: "epic:list",
			epics: [
				makePersistedEpic({
					epicId: "epic-both",
					title: "Analysis Title",
					status: "completed",
				}),
			],
		});
		mgr.handleMessage({
			type: "workflow:list",
			workflows: [
				makeWorkflowState({
					id: "child-x",
					epicId: "epic-both",
					epicTitle: "Aggregate Title",
					status: "completed",
				}),
			],
		});
		expect(backToEpicLabel("epic-both", mgr)).toBe("Aggregate Title");
	});

	test("composed label used by the DOM matches prefix + resolved title", () => {
		// Pins the contract that renderBackToEpicButton concatenates these two
		// pieces verbatim. A future refactor moving the composition (e.g. into
		// backToEpicLabel itself) would be caught here instead of only surfacing
		// via the integration test's final DOM assertion.
		const mgr = new ClientStateManager();
		mgr.handleMessage({
			type: "workflow:list",
			workflows: [
				makeWorkflowState({
					id: "child-1",
					epicId: "epic-42",
					epicTitle: "Dark mode initiative",
					status: "completed",
				}),
			],
		});
		const composed = BACK_TO_EPIC_PREFIX + backToEpicLabel("epic-42", mgr);
		expect(composed).toBe("\u2190 Back to Dark mode initiative");
	});

	test("composed label uses the literal 'epic' fallback when nothing is known", () => {
		const mgr = new ClientStateManager();
		const composed = BACK_TO_EPIC_PREFIX + backToEpicLabel("missing", mgr);
		expect(composed).toBe("\u2190 Back to epic");
	});
});
