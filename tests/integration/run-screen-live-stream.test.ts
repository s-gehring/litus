import { afterEach, describe, expect, it } from "bun:test";
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
