import { describe, expect, test } from "bun:test";
import type { ManagedRepoStore } from "../../src/managed-repo-store";
import { type PipelineCallbacks, PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import type { Workflow } from "../../src/types";
import { WorkflowEngine } from "../../src/workflow-engine";
import { makeWorkflow } from "../helpers";

function createTestDeps(opts: { releaseReject?: Error } = {}): {
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
			if (opts.releaseReject) throw opts.releaseReject;
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

	test("handleStepError does NOT release when managedRepo is set (error is retriable)", async () => {
		// Error is a retriable state, not a terminal one: `retryStep` re-enters
		// the spawn path at the same worktree, so releasing (and potentially
		// deleting) the clone on error would make every retry fail with a
		// missing-cwd error. Release is deferred to `completeWorkflow` or
		// `cancelPipeline`, which are the only true one-way exits.
		const { orch, engine, releaseCalls } = createTestDeps();
		const wf = makeWorkflow({
			status: "running",
			managedRepo: { owner: "Err", repo: "Path" },
		});
		wf.currentStepIndex = 0;
		engine.setWorkflow(wf);

		asPrivate(orch).handleStepError(wf.id, "boom");

		await new Promise((r) => setTimeout(r, 10));

		expect(releaseCalls).toHaveLength(0);
		expect(wf.managedRepo).toEqual({ owner: "Err", repo: "Path" });
		expect(wf.status).toBe("error");
	});

	test("handleStepError preserves managedRepo across re-entry so retry can spawn again", async () => {
		const { orch, engine, releaseCalls } = createTestDeps();
		const wf = makeWorkflow({
			status: "running",
			managedRepo: { owner: "Err", repo: "Path" },
		});
		wf.currentStepIndex = 0;
		engine.setWorkflow(wf);

		asPrivate(orch).handleStepError(wf.id, "boom");
		wf.status = "running";
		wf.steps[wf.currentStepIndex].status = "running";
		asPrivate(orch).handleStepError(wf.id, "boom again");

		await new Promise((r) => setTimeout(r, 10));

		expect(releaseCalls).toHaveLength(0);
		expect(wf.managedRepo).toEqual({ owner: "Err", repo: "Path" });
	});

	test("cancelPipeline from error state releases the managed-repo refcount", async () => {
		// Error is not terminal for refcount, so the refcount sits on an
		// errored workflow until the user chooses a one-way exit. Cancelling
		// from error IS that exit — it must fire exactly one release so the
		// clone is eventually cleaned up.
		const { orch, engine, releaseCalls } = createTestDeps();
		const wf = makeWorkflow({
			status: "running",
			managedRepo: { owner: "Err", repo: "Path" },
		});
		wf.currentStepIndex = 0;
		engine.setWorkflow(wf);

		asPrivate(orch).handleStepError(wf.id, "boom");
		await new Promise((r) => setTimeout(r, 10));
		expect(releaseCalls).toHaveLength(0);
		expect(wf.status).toBe("error");

		orch.cancelPipeline(wf.id);
		await new Promise((r) => setTimeout(r, 10));

		expect(releaseCalls).toHaveLength(1);
		expect(releaseCalls[0]).toEqual({ owner: "Err", repo: "Path" });
		expect(wf.status).toBe("cancelled");
		expect(wf.managedRepo).toBeNull();
	});
});

describe("PipelineOrchestrator — release() failure is contained", () => {
	// The orchestrator fires release() without awaiting, and attaches a `.catch`
	// that logs a warning. A rejecting release must not leak an unhandled
	// rejection or leave the workflow in a non-terminal state — callers rely on
	// these hooks being no-throw relative to the surrounding terminal transition.

	test("cancelPipeline still transitions to cancelled when release rejects", async () => {
		const { orch, engine, releaseCalls } = createTestDeps({
			releaseReject: new Error("rm failed: EBUSY"),
		});
		const wf = makeWorkflow({
			status: "paused",
			managedRepo: { owner: "Foo", repo: "Bar" },
		});
		engine.setWorkflow(wf);

		orch.cancelPipeline(wf.id);
		await new Promise((r) => setTimeout(r, 10));

		expect(releaseCalls).toHaveLength(1);
		// Workflow reached cancelled state; the rejected release did not
		// prevent the transition or leave managedRepo set.
		expect(wf.status).toBe("cancelled");
		expect(wf.managedRepo).toBeNull();
	});

	test("completeWorkflow still transitions to completed when release rejects", async () => {
		const { orch, engine, releaseCalls } = createTestDeps({
			releaseReject: new Error("rm failed: EACCES"),
		});
		const wf = makeWorkflow({
			status: "running",
			managedRepo: { owner: "Baz", repo: "Qux" },
		});
		engine.setWorkflow(wf);

		asPrivate(orch).completeWorkflow(wf);
		await new Promise((r) => setTimeout(r, 10));

		expect(releaseCalls).toHaveLength(1);
		expect(wf.status).toBe("completed");
		expect(wf.managedRepo).toBeNull();
	});

	// handleStepError used to release on error, so a rejecting release had to
	// be proven non-fatal for the error transition. Release no longer fires on
	// error, so the corresponding scenario is gone.
});
