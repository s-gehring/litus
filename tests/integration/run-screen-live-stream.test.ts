import { afterEach, describe, expect, it } from "bun:test";
import { ClientStateManager } from "../../src/client/client-state-manager";
import { projectRunScreenModel } from "../../src/client/components/run-screen/project-run-screen";
import { createRunScreenLayout } from "../../src/client/components/run-screen/run-screen-layout";
import type { ToolUsage, WorkflowClientState, WorkflowState } from "../../src/types";
import { makeWorkflowState } from "../helpers";

type StateStep = WorkflowState["steps"][number];

function step(overrides: Partial<StateStep>): StateStep {
	return {
		name: "implement",
		displayName: "Implementing",
		status: "pending",
		output: "",
		outputLog: [],
		error: null,
		startedAt: null,
		completedAt: null,
		history: [],
		...overrides,
	} as StateStep;
}

function entryFrom(overrides: Partial<WorkflowState> = {}): WorkflowClientState {
	return {
		state: makeWorkflowState({
			workflowKind: "spec",
			summary: "Demo task",
			status: "running",
			currentStepIndex: 1,
			steps: [
				step({ name: "setup", displayName: "Setup", status: "completed" }),
				step({ name: "implement", displayName: "Implementing", status: "running" }),
				step({ name: "review", displayName: "Review", status: "pending" }),
			],
			featureBranch: "feat/demo",
			worktreePath: "/tmp/demo",
			...overrides,
		}),
		outputLines: [],
	};
}

describe("run-screen live stream integration", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("workflow:state populates task header + stepper + config row + log console", () => {
		const entry = entryFrom();
		const model = projectRunScreenModel(entry, { config: null });
		const layout = createRunScreenLayout(model, {
			onPauseToggle: () => {},
			onModelChange: () => {},
			onEffortChange: () => {},
			onStepClick: () => {},
		});
		document.body.appendChild(layout.element);

		const header = layout.element.querySelector<HTMLElement>('[data-run-screen="task-header"]');
		expect(header).not.toBeNull();
		expect(header?.textContent ?? "").toContain("Demo task");

		const stepper = layout.element.querySelector<HTMLElement>(
			'[data-run-screen="pipeline-stepper"]',
		);
		expect(stepper).not.toBeNull();
		// Counter reflects the 1-based running index "step 2 / 3".
		expect(stepper?.textContent ?? "").toMatch(/step\s*2\s*\/\s*3/);

		const configRow = layout.element.querySelector<HTMLElement>('[data-run-screen="config-row"]');
		expect(configRow?.textContent ?? "").toContain("tokens");

		const logConsole = layout.element.querySelector<HTMLElement>('[data-run-screen="log-console"]');
		expect(logConsole?.textContent ?? "").toContain("Implementing");
	});

	it("workflow:output kinds drive log-console line rendering", () => {
		const entry = entryFrom({
			steps: [
				step({
					name: "implement",
					displayName: "Implementing",
					status: "running",
					outputLog: [
						{ kind: "text", text: "─── Section ───" },
						{ kind: "text", text: "hello world" },
					],
				}),
			],
			currentStepIndex: 0,
		});
		const model = projectRunScreenModel(entry, { config: null });
		const layout = createRunScreenLayout(model, {
			onPauseToggle: () => {},
			onModelChange: () => {},
			onEffortChange: () => {},
			onStepClick: () => {},
		});
		document.body.appendChild(layout.element);

		const sectionLines = layout.element.querySelectorAll('[data-log-kind="section"]');
		const outLines = layout.element.querySelectorAll('[data-log-kind="out"]');
		expect(sectionLines.length).toBeGreaterThanOrEqual(1);
		expect(outLines.length).toBeGreaterThanOrEqual(1);
	});

	it("workflow:tools populate touched-files and synthesise a toolstrip log event", () => {
		const tool: ToolUsage = {
			name: "Edit",
			input: { file_path: "/tmp/demo/src/foo.ts" },
		};
		const entry = entryFrom({
			steps: [
				step({
					name: "implement",
					displayName: "Implementing",
					status: "running",
					outputLog: [{ kind: "tools", tools: [tool] }],
				}),
			],
			currentStepIndex: 0,
		});
		const model = projectRunScreenModel(entry, { config: null });
		const layout = createRunScreenLayout(model, {
			onPauseToggle: () => {},
			onModelChange: () => {},
			onEffortChange: () => {},
			onStepClick: () => {},
		});
		document.body.appendChild(layout.element);

		const touched = layout.element.querySelector<HTMLElement>(
			'[data-run-screen="touched-files-card"]',
		);
		expect(touched?.textContent ?? "").toContain("foo.ts");

		const toolstrip = layout.element.querySelector('[data-log-kind="toolstrip"]');
		expect(toolstrip).not.toBeNull();
	});

	it("streaming workflow:output / workflow:tools through ClientStateManager reflects in the projected log (§1.1)", () => {
		// Code review §1.1: the prior test hand-rolled `outputLog` on the step
		// and bypassed the dispatch surface. This drives real messages through
		// ClientStateManager and asserts the projection picks up each message.
		const mgr = new ClientStateManager();
		const state = makeWorkflowState({
			id: "wf-live",
			workflowKind: "spec",
			status: "running",
			currentStepIndex: 0,
			steps: [step({ name: "implement", displayName: "Implementing", status: "running" })],
		});
		mgr.handleMessage({ type: "workflow:state", workflow: state });
		mgr.handleMessage({
			type: "workflow:output",
			workflowId: "wf-live",
			text: "hello from the model",
		});
		mgr.handleMessage({
			type: "workflow:tools",
			workflowId: "wf-live",
			tools: [{ name: "Edit", input: { file_path: "src/foo.ts" } }],
		});
		const entry = mgr.getWorkflows().get("wf-live");
		if (!entry) throw new Error("entry should be present");
		const projected = projectRunScreenModel(entry, { config: null });
		// The streamed text line is classified as `out` and reaches the model.
		const kinds = projected.log.events.map((e) => e.kind);
		expect(kinds).toContain("out");
		expect(kinds).toContain("toolstrip");
		// Tool counters reflect the streamed Edit tool.
		expect(projected.log.counters.toolCalls).toBe(1);
		expect(projected.log.counters.edits).toBe(1);
		// Touched files + caret anchor on the text event (not the trailing toolstrip).
		expect(projected.touched.some((f) => f.path.endsWith("foo.ts"))).toBe(true);
		if (projected.log.writingLineIndex == null) throw new Error("caret missing");
		expect(projected.log.events[projected.log.writingLineIndex].kind).toBe("out");
	});

	it("running step's durationMs advances from startedAt (§1.2 / FR-024)", () => {
		const startedAt = new Date(Date.now() - 65_000).toISOString();
		const entry = entryFrom({
			steps: [
				step({
					name: "implement",
					displayName: "Implementing",
					status: "running",
					startedAt,
				}),
			],
			currentStepIndex: 0,
		});
		const projected = projectRunScreenModel(entry, { config: null });
		const running = projected.pipeline.steps[0];
		expect(running.state).toBe("running");
		if (running.durationMs == null) throw new Error("durationMs missing on running step");
		// 65s elapsed ± tick jitter — allow ±2s.
		expect(running.durationMs).toBeGreaterThanOrEqual(63_000);
		expect(running.durationMs).toBeLessThanOrEqual(67_000);
	});

	it("completed step durationMs is the span between startedAt and completedAt", () => {
		const startedAt = new Date(Date.now() - 120_000).toISOString();
		const completedAt = new Date(Date.now() - 60_000).toISOString();
		const entry = entryFrom({
			steps: [
				step({
					name: "implement",
					displayName: "Implementing",
					status: "completed",
					startedAt,
					completedAt,
				}),
			],
			currentStepIndex: 0,
		});
		const projected = projectRunScreenModel(entry, { config: null });
		expect(projected.pipeline.steps[0].durationMs).toBeGreaterThanOrEqual(59_000);
		expect(projected.pipeline.steps[0].durationMs).toBeLessThanOrEqual(61_000);
	});

	it("workflow:step-change re-renders stepper + upcoming with the new currentStepIndex", () => {
		const entry = entryFrom();
		const initial = projectRunScreenModel(entry, { config: null });
		const layout = createRunScreenLayout(initial, {
			onPauseToggle: () => {},
			onModelChange: () => {},
			onEffortChange: () => {},
			onStepClick: () => {},
		});
		document.body.appendChild(layout.element);

		// Simulate step-change: advance to the final step.
		entry.state.currentStepIndex = 2;
		entry.state.steps[1].status = "completed";
		entry.state.steps[2].status = "running";
		const advanced = projectRunScreenModel(entry, { config: null });
		layout.update(advanced);

		const stepper = layout.element.querySelector<HTMLElement>(
			'[data-run-screen="pipeline-stepper"]',
		);
		expect(stepper?.textContent ?? "").toMatch(/step\s*3\s*\/\s*3/);

		const upcoming = layout.element.querySelector<HTMLElement>('[data-run-screen="upcoming-card"]');
		// The review step is running now, so upcoming is empty → "Pipeline complete."
		expect(upcoming?.textContent ?? "").toContain("Pipeline complete");
	});
});
