import { describe, expect, test } from "bun:test";
import { CLIRunner } from "../../src/cli-runner";
import { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type { PipelineCallbacks } from "../../src/types";
import { WorkflowEngine } from "../../src/workflow-engine";
import { WorkflowStore } from "../../src/workflow-store";

// Minimal stub callbacks that track calls per workflowId
function createTracker() {
	const stateChanges: string[] = [];
	const outputs: Array<{ workflowId: string; text: string }> = [];
	const errors: Array<{ workflowId: string; error: string }> = [];

	const callbacks: PipelineCallbacks = {
		onStepChange: () => {},
		onOutput: (workflowId: string, text: string) => {
			outputs.push({ workflowId, text });
		},
		onTools: () => {},
		onComplete: (workflowId: string) => {
			stateChanges.push(`complete:${workflowId}`);
		},
		onError: (workflowId: string, error: string) => {
			errors.push({ workflowId, error });
		},
		onStateChange: (workflowId: string) => {
			stateChanges.push(`state:${workflowId}`);
		},
	};

	return { callbacks, stateChanges, outputs, errors };
}

describe("Multi-workflow concurrent orchestrators", () => {
	test("two orchestrators can hold independent workflows", () => {
		const tracker1 = createTracker();
		const tracker2 = createTracker();

		// Create separate engines (one per orchestrator, as per architecture)
		const engine1 = new WorkflowEngine();
		const engine2 = new WorkflowEngine();

		const orch1 = new PipelineOrchestrator(tracker1.callbacks, { engine: engine1 });
		const orch2 = new PipelineOrchestrator(tracker2.callbacks, { engine: engine2 });

		// Verify they are independent
		expect(orch1.getEngine()).not.toBe(orch2.getEngine());
		expect(orch1.getEngine().getWorkflow()).toBeNull();
		expect(orch2.getEngine().getWorkflow()).toBeNull();
	});

	test("shared CLIRunner can be used across orchestrators", () => {
		const sharedCli = new CLIRunner();
		const tracker1 = createTracker();
		const tracker2 = createTracker();

		const orch1 = new PipelineOrchestrator(tracker1.callbacks, { cliRunner: sharedCli });
		const orch2 = new PipelineOrchestrator(tracker2.callbacks, { cliRunner: sharedCli });

		// Both orchestrators share the same CLI runner instance
		expect(orch1).toBeDefined();
		expect(orch2).toBeDefined();
	});

	test("shared WorkflowStore can be used across orchestrators", () => {
		const sharedStore = new WorkflowStore("/tmp/test-multi-workflow-store");
		const tracker1 = createTracker();
		const tracker2 = createTracker();

		const orch1 = new PipelineOrchestrator(tracker1.callbacks, { workflowStore: sharedStore });
		const orch2 = new PipelineOrchestrator(tracker2.callbacks, { workflowStore: sharedStore });

		expect(orch1.getStore()).toBe(sharedStore);
		expect(orch2.getStore()).toBe(sharedStore);
	});

	test("orchestrator map pattern routes to correct instance", () => {
		const tracker1 = createTracker();
		const tracker2 = createTracker();

		const engine1 = new WorkflowEngine();
		const engine2 = new WorkflowEngine();

		const orch1 = new PipelineOrchestrator(tracker1.callbacks, { engine: engine1 });
		const orch2 = new PipelineOrchestrator(tracker2.callbacks, { engine: engine2 });

		// Simulate the Map<workflowId, PipelineOrchestrator> pattern
		const orchestrators = new Map<string, PipelineOrchestrator>();
		orchestrators.set("wf-1", orch1);
		orchestrators.set("wf-2", orch2);

		// Lookup by workflowId
		expect(orchestrators.get("wf-1")).toBe(orch1);
		expect(orchestrators.get("wf-2")).toBe(orch2);
		expect(orchestrators.get("wf-3")).toBeUndefined();
	});
});
