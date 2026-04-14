import { describe, expect, test } from "bun:test";
import type { ManagedRepoStore } from "../../src/managed-repo-store";
import { type PipelineCallbacks, PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type { Workflow } from "../../src/types";
import { WorkflowEngine } from "../../src/workflow-engine";
import { makeWorkflow } from "../helpers";

function createTestDeps(): {
	orch: PipelineOrchestrator;
	engine: WorkflowEngine;
	releaseCalls: { owner: string; repo: string }[];
} {
	const releaseCalls: { owner: string; repo: string }[] = [];
	const store = {
		async acquire() {
			throw new Error("not expected");
		},
		async release(owner: string, repo: string) {
			releaseCalls.push({ owner, repo });
		},
		async seedFromWorkflows() {},
		async bumpRefCount() {},
	} as unknown as ManagedRepoStore;

	const callbacks: PipelineCallbacks = {
		onStepChange() {},
		onOutput() {},
		onTools() {},
		onComplete() {},
		onError() {},
		onStateChange() {},
	};

	const engine = new WorkflowEngine();
	const orch = new PipelineOrchestrator(callbacks, {
		engine,
		managedRepoStore: store,
	});
	return { orch, engine, releaseCalls };
}

interface PrivateOrchestrator {
	completeWorkflow(workflow: Workflow): void;
	handleStepError(workflowId: string, error: string): void;
}

function asPrivate(orch: PipelineOrchestrator): PrivateOrchestrator {
	return orch as unknown as PrivateOrchestrator;
}

describe("PipelineOrchestrator — managed-repo release hook", () => {
	test("cancelPipeline calls release exactly once when managedRepo is set", async () => {
		const { orch, engine, releaseCalls } = createTestDeps();
		const wf = makeWorkflow({
			status: "paused",
			managedRepo: { owner: "Foo", repo: "Bar" },
		});
		engine.setWorkflow(wf);

		orch.cancelPipeline(wf.id);

		// Release is scheduled via a promise chain — wait a tick
		await new Promise((r) => setTimeout(r, 10));

		expect(releaseCalls).toHaveLength(1);
		expect(releaseCalls[0]).toEqual({ owner: "Foo", repo: "Bar" });
	});

	test("cancelPipeline does NOT call release when managedRepo is null", async () => {
		const { orch, engine, releaseCalls } = createTestDeps();
		const wf = makeWorkflow({
			status: "paused",
			managedRepo: null,
		});
		engine.setWorkflow(wf);

		orch.cancelPipeline(wf.id);
		await new Promise((r) => setTimeout(r, 10));

		expect(releaseCalls).toHaveLength(0);
	});

	test("completeWorkflow calls release exactly once when managedRepo is set", async () => {
		const { orch, engine, releaseCalls } = createTestDeps();
		const wf = makeWorkflow({
			status: "running",
			managedRepo: { owner: "Baz", repo: "Qux" },
		});
		engine.setWorkflow(wf);

		asPrivate(orch).completeWorkflow(wf);

		await new Promise((r) => setTimeout(r, 10));

		expect(releaseCalls).toHaveLength(1);
		expect(releaseCalls[0]).toEqual({ owner: "Baz", repo: "Qux" });
	});

	test("handleStepError calls release exactly once when managedRepo is set", async () => {
		const { orch, engine, releaseCalls } = createTestDeps();
		const wf = makeWorkflow({
			status: "running",
			managedRepo: { owner: "Err", repo: "Path" },
		});
		// Ensure the current step is NOT feedback-implementer (which early-returns).
		wf.currentStepIndex = 0;
		engine.setWorkflow(wf);

		asPrivate(orch).handleStepError(wf.id, "boom");

		await new Promise((r) => setTimeout(r, 10));

		expect(releaseCalls).toHaveLength(1);
		expect(releaseCalls[0]).toEqual({ owner: "Err", repo: "Path" });
	});

	test("re-entry into handleStepError (retry → error) does not double-release", async () => {
		// `error → running` is a valid transition (retry). A retried workflow
		// can fail again and re-enter `handleStepError`; the release hook must
		// not fire a second time for the same acquire.
		const { orch, engine, releaseCalls } = createTestDeps();
		const wf = makeWorkflow({
			status: "running",
			managedRepo: { owner: "Err", repo: "Path" },
		});
		wf.currentStepIndex = 0;
		engine.setWorkflow(wf);

		asPrivate(orch).handleStepError(wf.id, "boom");
		// Simulate retry re-arming the step so the second error path runs fully.
		wf.status = "running";
		wf.steps[wf.currentStepIndex].status = "running";
		asPrivate(orch).handleStepError(wf.id, "boom again");

		await new Promise((r) => setTimeout(r, 10));

		expect(releaseCalls).toHaveLength(1);
	});
});
