import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PipelineCallbacks, PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import { WorkflowStore } from "../../src/workflow-store";
import { makeWorkflow } from "../helpers";

// Behavioral coverage of FR-002 / SC-002: a real PipelineOrchestrator's
// dependency check emits `epic-finished` when every sibling has reached a
// terminal state and the caller has not opted into suppression, and skips
// the emission when the caller passes `suppressEpicFinishedAlert: true`.
// Driven directly against `checkEpicDependencies` (private) so the contract
// is exercised independently of the abortPipeline machinery — the H2/H3
// review gap that source-grep tests left uncovered. This file deliberately
// avoids `mock.module` so the test does not pollute workflow-engine for
// later test files in the bun run.

describe("PipelineOrchestrator.checkEpicDependencies — epic-finished suppression", () => {
	test("suppressEpicFinishedAlert=true skips emission; default emits exactly once", async () => {
		const storeDir = mkdtempSync(join(tmpdir(), "alert-suppress-"));
		const store = new WorkflowStore(storeDir);
		const epicId = `epic-${Date.now()}`;

		const trigger = makeWorkflow({
			id: "wf-trigger",
			epicId,
			epicTitle: "Test Epic",
			status: "aborted",
		});
		const sibling1 = makeWorkflow({ id: "wf-sib-1", epicId, status: "completed" });
		const sibling2 = makeWorkflow({ id: "wf-sib-2", epicId, status: "completed" });
		await store.save(sibling1);
		await store.save(sibling2);
		await store.save(trigger);

		const alerts: Array<{ type: string; epicId?: string | null }> = [];
		const callbacks: PipelineCallbacks = {
			onStepChange: () => {},
			onOutput: () => {},
			onTools: () => {},
			onComplete: () => {},
			onError: () => {},
			onStateChange: () => {},
			onAlertEmit: (alert) => {
				alerts.push({ type: alert.type, epicId: alert.epicId });
			},
		};
		const orch = new PipelineOrchestrator(callbacks, { workflowStore: store });

		// Suppressed path: feedback flow opts in → no epic-finished emitted.
		// biome-ignore lint/suspicious/noExplicitAny: private method probe.
		await (orch as any).checkEpicDependencies(trigger, { suppressEpicFinishedAlert: true });
		expect(alerts.filter((a) => a.type === "epic-finished")).toHaveLength(0);

		// Default path: same workflow state, no opt-in → epic-finished fires.
		// biome-ignore lint/suspicious/noExplicitAny: private method probe.
		await (orch as any).checkEpicDependencies(trigger);
		const finished = alerts.filter((a) => a.type === "epic-finished" && a.epicId === epicId);
		expect(finished).toHaveLength(1);
	});
});
