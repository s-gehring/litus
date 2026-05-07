import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PipelineCallbacks, PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import { WorkflowStore } from "../../src/workflow-store";
import { makeWorkflow } from "../helpers";

// Regression for the "first spec vanishes, the rest auto-start" bug on epic
// feedback. `runFeedbackAttempt` aborts every child workflow before re-running
// the decomposition agent. Each abort used to fire `checkEpicDependencies`,
// which adds the trigger workflow to `completedIds` regardless of its real
// terminal status — flipping a sibling whose only dependency was the
// just-aborted workflow to `satisfied`. `onEpicDependencyUpdate` then
// auto-started it via `server.ts` before `deleteChildWorkflows` could remove
// it. The fix threads a `skipEpicDependencyCheck` flag through `abortPipeline`
// so the feedback cleanup skips the dependency cascade entirely.
//
// Test driven by spying on `checkEpicDependencies` (private) directly so the
// assertion is invariant to (a) any unrelated work `abortPipeline` does and
// (b) the timing of the fire-and-forget Promise it would otherwise spawn.

describe("PipelineOrchestrator.abortPipeline — skipEpicDependencyCheck", () => {
	function buildOrch(): {
		orch: PipelineOrchestrator;
		spyCalls: number;
	} {
		const storeDir = mkdtempSync(join(tmpdir(), "abort-skip-dep-"));
		const store = new WorkflowStore(storeDir);
		const callbacks: PipelineCallbacks = {
			onStepChange: () => {},
			onOutput: () => {},
			onTools: () => {},
			onComplete: () => {},
			onError: () => {},
			onStateChange: () => {},
		};
		const orch = new PipelineOrchestrator(callbacks, { workflowStore: store });
		const state = { spyCalls: 0 };
		// biome-ignore lint/suspicious/noExplicitAny: private method spy.
		(orch as any).checkEpicDependencies = async () => {
			state.spyCalls += 1;
		};
		return {
			orch,
			get spyCalls() {
				return state.spyCalls;
			},
		};
	}

	test("skipEpicDependencyCheck=true does not invoke checkEpicDependencies", () => {
		const ctx = buildOrch();
		const trigger = makeWorkflow({
			id: "wf-trigger-skip",
			epicId: `epic-${Date.now()}-skip`,
			status: "waiting_for_dependencies",
			epicDependencies: [],
		});
		ctx.orch.getEngine().setWorkflow(trigger);

		ctx.orch.abortPipeline("wf-trigger-skip", { skipEpicDependencyCheck: true });

		expect(ctx.spyCalls).toBe(0);
	});

	test("default (no flag) still invokes checkEpicDependencies — guards the inverse", () => {
		const ctx = buildOrch();
		const trigger = makeWorkflow({
			id: "wf-trigger-default",
			epicId: `epic-${Date.now()}-default`,
			status: "waiting_for_dependencies",
			epicDependencies: [],
		});
		ctx.orch.getEngine().setWorkflow(trigger);

		ctx.orch.abortPipeline("wf-trigger-default");

		expect(ctx.spyCalls).toBe(1);
	});
});
