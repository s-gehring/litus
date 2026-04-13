import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { broadcastPersistedWorkflowState } from "../../src/server/workflow-broadcaster";
import type { ServerMessage, Workflow, WorkflowState } from "../../src/types";
import { WorkflowStore } from "../../src/workflow-store";
import { makeWorkflow } from "../helpers";

/**
 * Regression for code-review-4 §1.3: after `cancelPipeline` deletes the
 * orchestrator, the post-cancel commit-backfill callback still fires
 * `onStateChange`. The server must load the persisted workflow from disk and
 * broadcast it so the client sees the backfilled `commitRefs` without a page
 * reload.
 */
describe("broadcastPersistedWorkflowState (cancelPipeline post-delete fallback)", () => {
	let baseDir: string;
	let store: WorkflowStore;

	beforeEach(() => {
		baseDir = join(
			tmpdir(),
			`workflow-broadcaster-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(baseDir, { recursive: true });
		store = new WorkflowStore(baseDir);
	});

	afterEach(() => {
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	// Mirror of server.ts stripInternalFields — feedbackPreRunHead is stripped.
	function strip(w: Workflow): WorkflowState {
		const { steps, feedbackPreRunHead: _fph, ...rest } = w;
		return {
			...rest,
			steps: steps.map(({ sessionId: _sid, prompt: _p, pid: _pid, ...step }) => step),
		};
	}

	test("broadcasts persisted state when the orchestrator is gone", async () => {
		const wf = makeWorkflow({ id: "wf-cancel-1" });
		wf.feedbackEntries = [
			{
				id: "fe-1",
				iteration: 1,
				text: "do the thing",
				submittedAt: "2026-04-13T00:00:00.000Z",
				submittedAtStepName: "merge-pr",
				outcome: {
					value: "cancelled",
					summary: "Cancelled by user abort",
					commitRefs: ["backfill-abc"],
					warnings: [],
				},
			},
		];
		await store.save(wf);

		const sent: ServerMessage[] = [];
		await broadcastPersistedWorkflowState("wf-cancel-1", store, strip, (m) => sent.push(m));

		expect(sent).toHaveLength(1);
		const msg = sent[0];
		expect(msg.type).toBe("workflow:state");
		if (msg.type === "workflow:state" && msg.workflow) {
			expect(msg.workflow.feedbackEntries[0].outcome?.commitRefs).toEqual(["backfill-abc"]);
			// feedbackPreRunHead stripped from the wire — see review §1.1.
			expect((msg.workflow as { feedbackPreRunHead?: unknown }).feedbackPreRunHead).toBeUndefined();
		}
	});

	test("does not broadcast when the workflow is not on disk", async () => {
		const sent: ServerMessage[] = [];
		await broadcastPersistedWorkflowState("wf-missing", store, strip, (m) => sent.push(m));

		expect(sent).toHaveLength(0);
	});

	test("swallows store.load errors so a failing disk read does not crash the broadcast", async () => {
		const sent: ServerMessage[] = [];
		const failingStore = {
			load: async () => {
				throw new Error("simulated disk read failure");
			},
		} as unknown as WorkflowStore;

		await broadcastPersistedWorkflowState("wf-any", failingStore, strip, (m) => sent.push(m));

		expect(sent).toHaveLength(0);
	});
});
