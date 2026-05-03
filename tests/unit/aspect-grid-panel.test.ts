// DOM-facing render tests for the per-aspect grid panel. Locks in:
//   1) tool usages render as icon badges (not `[Tool]` text), matching the
//      app-wide icon convention used in `output-log`.
//   2) the panel has a fixed height set via CSS class so all panels stay the
//      same size regardless of content volume.
//
// Relies on Bun's built-in happy-dom shim.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	applyAspectStateUpdate,
	applyAspectToolsDelta,
	renderAspectGridPanel,
} from "../../src/client/components/aspect-grid-panel";
import type { AspectState, WorkflowState } from "../../src/types";
import { makeWorkflowState } from "../helpers";

function makeAspect(overrides: Partial<AspectState> = {}): AspectState {
	return {
		id: "a1",
		fileName: "a1.md",
		status: "in_progress",
		sessionId: null,
		startedAt: null,
		completedAt: null,
		errorMessage: null,
		output: "",
		outputLog: [],
		...overrides,
	};
}

function mountWorkflow(): { container: HTMLElement; workflow: WorkflowState } {
	document.body.innerHTML = '<div id="output-area"></div>';
	const container = document.getElementById("output-area") as HTMLElement;
	const workflow = makeWorkflowState({ id: "wf-1" });
	workflow.aspectManifest = {
		version: 1,
		aspects: [{ id: "a1", title: "Aspect 1", researchPrompt: "Prompt 1", fileName: "a1.md" }],
	};
	workflow.aspects = [makeAspect()];
	return { container, workflow };
}

describe("aspect-grid-panel — tool icon rendering", () => {
	let container: HTMLElement;
	let workflow: WorkflowState;

	beforeEach(() => {
		const m = mountWorkflow();
		container = m.container;
		workflow = m.workflow;
		renderAspectGridPanel(container, workflow);
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	test("applyAspectToolsDelta renders icon badges, not [Tool] text", () => {
		applyAspectToolsDelta(container, "a1", [{ name: "Bash", input: { command: "echo hi" } }]);
		const out = container.querySelector("#aspect-panel-output-a1") as HTMLElement;
		// Icon badge is present.
		expect(out.querySelector(".tool-icons")).not.toBeNull();
		expect(out.querySelectorAll(".tool-icon").length).toBe(1);
		// Legacy `[Bash]` text rendering is gone.
		expect(out.textContent ?? "").not.toContain("[Bash]");
	});

	test("applyAspectStateUpdate replays outputLog as icon badges for tool entries", () => {
		applyAspectStateUpdate(
			container,
			makeAspect({
				outputLog: [
					{ kind: "text", text: "scanning…" },
					{ kind: "tools", tools: [{ name: "Grep", input: { pattern: "x" } }] },
				],
			}),
		);
		const out = container.querySelector("#aspect-panel-output-a1") as HTMLElement;
		expect(out.querySelectorAll(".tool-icon").length).toBe(1);
		expect(out.textContent ?? "").not.toContain("[Grep]");
	});
});

describe("aspect-grid-panel — fixed panel height", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	test("each aspect panel uses the .aspect-panel class so CSS gives it a fixed height", () => {
		const { container, workflow } = mountWorkflow();
		renderAspectGridPanel(container, workflow);
		const panel = container.querySelector("#aspect-panel-a1") as HTMLElement;
		expect(panel).not.toBeNull();
		expect(panel.classList.contains("aspect-panel")).toBe(true);
	});
});
