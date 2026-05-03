import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerMessage } from "../../src/protocol";
import { handleRetryWorkflow } from "../../src/server/workflow-handlers";
import type { Workflow } from "../../src/types";
import { makeWorkflow } from "../helpers";

// Minimal stand-ins: these tests exercise `handleRetryWorkflow` directly with
// hand-crafted deps, without spinning up a server. They target the state gate,
// `invalid_state` / `not_found` code emission, dedupe via
// `retryWorkflowInFlight`, and the persist + broadcast sequencing — the exact
// paths where regressions would be hardest to catch in code review.

const originalSpawn = Bun.spawn;
const BunGlobal = globalThis as unknown as { Bun: { spawn: unknown } };

function mockGitSpawn(exitCode = 0, stderr = "") {
	BunGlobal.Bun.spawn = (() => ({
		exited: Promise.resolve(exitCode),
		stdout: new ReadableStream({
			start(c) {
				c.close();
			},
		}),
		stderr: new ReadableStream({
			start(c) {
				if (stderr) c.enqueue(new TextEncoder().encode(stderr));
				c.close();
			},
		}),
	})) as unknown;
}

interface SentMessage {
	msg: ServerMessage;
}

interface MockOrchestrator {
	getEngine: () => {
		setWorkflow: (w: Workflow) => void;
		getWorkflow: () => Workflow | null;
	};
	startPipelineFromWorkflow: (w: Workflow) => void;
	startCalls: Workflow[];
}

function createMockOrchestrator(
	opts: { startThrows?: boolean; liveWorkflow?: Workflow | null } = {},
): MockOrchestrator {
	const startCalls: Workflow[] = [];
	let live: Workflow | null = opts.liveWorkflow ?? null;
	return {
		getEngine: () => ({
			setWorkflow: (w: Workflow) => {
				live = w;
			},
			getWorkflow: () => live,
		}),
		startPipelineFromWorkflow: (w: Workflow) => {
			if (opts.startThrows) throw new Error("simulated start failure");
			startCalls.push(w);
		},
		startCalls,
	};
}

function makeDeps(
	workflow: Workflow | null,
	options: { startThrows?: boolean; existingOrch?: MockOrchestrator } = {},
) {
	const sent: SentMessage[] = [];
	const broadcasts: string[] = [];
	const saved: Workflow[] = [];
	const auditEvents: Record<string, unknown>[] = [];
	const createdOrchestrators: MockOrchestrator[] = [];

	const orchestrators = new Map<string, MockOrchestrator>();
	if (options.existingOrch && workflow) {
		orchestrators.set(workflow.id, options.existingOrch);
	}

	const deps = {
		orchestrators,
		broadcast: (_msg: ServerMessage) => {},
		sendTo: (_ws: unknown, msg: ServerMessage) => {
			sent.push({ msg });
		},
		sharedStore: {
			save: async (wf: Workflow) => {
				saved.push(wf);
			},
			load: async (id: string) =>
				workflow && workflow.id === id ? structuredClone(workflow) : null,
		},
		sharedAuditLogger: {
			logWorkflowReset: (payload: Record<string, unknown>) => {
				auditEvents.push(payload);
			},
		},
		broadcastWorkflowState: (id: string) => {
			broadcasts.push(id);
		},
		createOrchestrator: () => {
			const orch = createMockOrchestrator({ startThrows: options.startThrows });
			createdOrchestrators.push(orch);
			return orch;
		},
	} as unknown as Parameters<typeof handleRetryWorkflow>[2];

	return { deps, sent, broadcasts, saved, auditEvents, orchestrators, createdOrchestrators };
}

describe("handleRetryWorkflow", () => {
	beforeEach(() => {
		mockGitSpawn(0);
	});

	afterEach(() => {
		BunGlobal.Bun.spawn = originalSpawn;
	});

	test("rejects unknown workflow id with code not_found", async () => {
		const { deps, sent } = makeDeps(null);
		await handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "nope" },
			deps,
		);
		expect(sent).toHaveLength(1);
		const msg = sent[0].msg as Extract<ServerMessage, { type: "error" }>;
		expect(msg.type).toBe("error");
		expect(msg.requestType).toBe("workflow:retry-workflow");
		expect(msg.code).toBe("not_found");
	});

	test("rejects missing workflowId with code not_found", async () => {
		const { deps, sent } = makeDeps(null);
		await handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "" },
			deps,
		);
		expect(sent).toHaveLength(1);
		const msg = sent[0].msg as Extract<ServerMessage, { type: "error" }>;
		expect(msg.code).toBe("not_found");
	});

	test("rejects non-error/aborted status with code invalid_state", async () => {
		const wf = makeWorkflow({ id: "wf-running", status: "running" });
		const { deps, sent } = makeDeps(wf);
		await handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "wf-running" },
			deps,
		);
		expect(sent).toHaveLength(1);
		const msg = sent[0].msg as Extract<ServerMessage, { type: "error" }>;
		expect(msg.code).toBe("invalid_state");
		expect(msg.requestType).toBe("workflow:retry-workflow");
	});

	test("success: persists, audits, broadcasts workflow state", async () => {
		const wf = makeWorkflow({
			id: "wf-ok",
			status: "aborted",
			worktreePath: "/tmp/p",
			worktreeBranch: "tmp-ok",
			targetRepository: "/tmp/repo",
			epicId: "epic-1",
		});
		const { deps, sent, saved, auditEvents, broadcasts } = makeDeps(wf);

		await handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "wf-ok" },
			deps,
		);

		expect(sent).toHaveLength(0);
		expect(saved).toHaveLength(1);
		expect(saved[0].status).toBe("idle");
		expect(auditEvents).toHaveLength(1);
		expect(auditEvents[0].partialFailure).toBe(false);
		expect(broadcasts).toEqual(["wf-ok"]);
	});

	test("success from aborted: re-registers orchestrator so Start can launch", async () => {
		// Abort deletes the orchestrator from the map; without re-registration
		// here the subsequent `workflow:start-existing` would fail in
		// `withOrchestrator` and the operator would be stuck on an idle
		// workflow they cannot launch.
		const wf = makeWorkflow({
			id: "wf-reg",
			status: "aborted",
			worktreePath: null,
			worktreeBranch: "tmp-reg",
			targetRepository: "/tmp/repo",
			epicId: "epic-1",
		});
		const { deps, orchestrators, createdOrchestrators } = makeDeps(wf);

		await handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "wf-reg" },
			deps,
		);

		expect(createdOrchestrators).toHaveLength(1);
		expect(orchestrators.get("wf-reg")).toBe(createdOrchestrators[0]);
	});

	test("partial cleanup failure still re-registers orchestrator", async () => {
		// Even when branch/worktree/artifact cleanup reports a failure and the
		// workflow transitions to `error` rather than `idle`, the orchestrator
		// must be present in the map so the operator can issue another retry —
		// otherwise `withOrchestrator` reports a misleading "Workflow not
		// found" for subsequent actions against a workflow that very much
		// exists on disk.
		mockGitSpawn(1, "fatal: could not remove worktree");
		const wf = makeWorkflow({
			id: "wf-partial",
			status: "aborted",
			worktreePath: "/tmp/p",
			worktreeBranch: "tmp-partial",
			targetRepository: "/tmp/repo",
			epicId: "epic-1",
		});
		const { deps, orchestrators, createdOrchestrators, auditEvents } = makeDeps(wf);

		await handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "wf-partial" },
			deps,
		);

		expect(auditEvents).toHaveLength(1);
		expect(auditEvents[0].partialFailure).toBe(true);
		expect(createdOrchestrators).toHaveLength(1);
		expect(orchestrators.get("wf-partial")).toBe(createdOrchestrators[0]);
	});

	test("standalone (non-epic) workflow auto-starts after restart", async () => {
		// Regression for fix/022: a standalone workflow (typically ask-question
		// or a Quick Fix outside an epic) has no Start button in the detail
		// action bar — `buildActionButtons` only emits one when `wf.epicId` is
		// set. Without auto-start, the operator's "Restart" click strands the
		// workflow at idle with no UI control to launch it.
		const wf = makeWorkflow({
			id: "wf-standalone",
			workflowKind: "ask-question",
			status: "error",
			worktreePath: null,
			worktreeBranch: "tmp-aq",
			targetRepository: "/tmp/repo",
			epicId: null,
		});
		const { deps, createdOrchestrators, broadcasts, saved } = makeDeps(wf);

		await handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "wf-standalone" },
			deps,
		);

		expect(saved).toHaveLength(1);
		expect(saved[0].status).toBe("idle");
		expect(createdOrchestrators).toHaveLength(1);
		expect(createdOrchestrators[0].startCalls).toHaveLength(1);
		expect(createdOrchestrators[0].startCalls[0].id).toBe("wf-standalone");
		expect(broadcasts).toEqual(["wf-standalone"]);
	});

	test("standalone workflow with existing orchestrator also auto-starts after restart", async () => {
		// `error`-state workflows keep their orchestrator registered, so the
		// retry path takes the "reuse existing orch" branch. Auto-start must
		// fire on that branch too, otherwise standalone errored workflows
		// that were never aborted get stranded the same way.
		const existingOrch = createMockOrchestrator();
		const wf = makeWorkflow({
			id: "wf-existing-orch",
			workflowKind: "ask-question",
			status: "error",
			worktreePath: null,
			worktreeBranch: "tmp-eo",
			targetRepository: "/tmp/repo",
			epicId: null,
		});
		const { deps } = makeDeps(wf, { existingOrch });

		await handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "wf-existing-orch" },
			deps,
		);

		expect(existingOrch.startCalls).toHaveLength(1);
		expect(existingOrch.startCalls[0].id).toBe("wf-existing-orch");
	});

	test("epic-attached workflow does NOT auto-start after restart", async () => {
		// Epic-bound child specs may be gated by sibling dependencies; the
		// existing UX is to leave them at idle so the operator can decide when
		// to start. Auto-starting them would bypass that gate. The Start
		// button (rendered when `wf.epicId` is set) is the launch surface for
		// these workflows.
		const wf = makeWorkflow({
			id: "wf-epic",
			status: "aborted",
			worktreePath: null,
			worktreeBranch: "tmp-epic",
			targetRepository: "/tmp/repo",
			epicId: "epic-parent",
		});
		const { deps, createdOrchestrators } = makeDeps(wf);

		await handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "wf-epic" },
			deps,
		);

		expect(createdOrchestrators).toHaveLength(1);
		expect(createdOrchestrators[0].startCalls).toHaveLength(0);
	});

	test("standalone workflow with partial cleanup failure does NOT auto-start", async () => {
		// On partial cleanup failure resetWorkflow leaves the workflow in
		// `error` state, not `idle`. Auto-starting on top of a half-cleaned
		// worktree would compound the problem; the operator should re-issue
		// Restart to converge before the workflow runs again.
		mockGitSpawn(1, "fatal: could not remove worktree");
		const wf = makeWorkflow({
			id: "wf-standalone-partial",
			workflowKind: "ask-question",
			status: "aborted",
			worktreePath: "/tmp/p",
			worktreeBranch: "tmp-sp",
			targetRepository: "/tmp/repo",
			epicId: null,
		});
		const { deps, createdOrchestrators, saved } = makeDeps(wf);

		await handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "wf-standalone-partial" },
			deps,
		);

		expect(saved).toHaveLength(1);
		expect(saved[0].status).toBe("error");
		expect(createdOrchestrators[0].startCalls).toHaveLength(0);
	});

	test("auto-start failure is logged but does not break the broadcast", async () => {
		// If `startPipelineFromWorkflow` throws (e.g. a transient git-state
		// hiccup), the workflow is already persisted as idle and audited.
		// The handler must still broadcast so the client reflects the reset
		// — otherwise the operator sees a stale `error` card.
		const wf = makeWorkflow({
			id: "wf-start-throws",
			workflowKind: "ask-question",
			status: "error",
			worktreePath: null,
			worktreeBranch: "tmp-th",
			targetRepository: "/tmp/repo",
			epicId: null,
		});
		const { deps, broadcasts, saved } = makeDeps(wf, { startThrows: true });

		await handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "wf-start-throws" },
			deps,
		);

		expect(saved).toHaveLength(1);
		expect(saved[0].status).toBe("idle");
		expect(broadcasts).toEqual(["wf-start-throws"]);
	});

	test("dedupe: second call while first in flight is a no-op", async () => {
		const wf = makeWorkflow({
			id: "wf-dup",
			status: "error",
			worktreePath: null,
			worktreeBranch: "tmp-dup",
			targetRepository: "/tmp/repo",
		});
		const { deps, sent, broadcasts, saved, auditEvents } = makeDeps(wf);

		const p1 = handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "wf-dup" },
			deps,
		);
		const p2 = handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "wf-dup" },
			deps,
		);
		await Promise.all([p1, p2]);

		expect(sent).toHaveLength(0);
		// Single broadcast despite two sends — the dedupe guard dropped the
		// second one without emitting any response.
		expect(broadcasts).toEqual(["wf-dup"]);
		// Harden: prove the second call is a full no-op end-to-end, not just
		// that some other broadcast didn't happen to fire. If dedupe broke,
		// the second invocation would also run `resetWorkflow` → save → audit.
		expect(saved).toHaveLength(1);
		expect(auditEvents).toHaveLength(1);
	});

	test("persist failure: emits a persist_failed error instead of broadcasting stale state", async () => {
		const wf = makeWorkflow({
			id: "wf-persist-fail",
			status: "aborted",
			worktreePath: null,
			worktreeBranch: "tmp-pf",
			targetRepository: "/tmp/repo",
		});
		const { deps, sent, saved, auditEvents, broadcasts } = makeDeps(wf);
		// Force `sharedStore.save` to throw — simulates EACCES/disk-full.
		deps.sharedStore.save = async () => {
			throw new Error("ENOSPC");
		};

		await handleRetryWorkflow(
			{} as never,
			{ type: "workflow:retry-workflow", workflowId: "wf-persist-fail" },
			deps,
		);

		expect(saved).toHaveLength(0);
		// Audit + broadcast MUST NOT fire when persistence fails: otherwise the
		// audit log and clients would diverge from the on-disk record.
		expect(auditEvents).toHaveLength(0);
		expect(broadcasts).toEqual([]);
		expect(sent).toHaveLength(1);
		const msg = sent[0].msg as Extract<ServerMessage, { type: "error" }>;
		expect(msg.type).toBe("error");
		expect(msg.requestType).toBe("workflow:retry-workflow");
		expect(msg.code).toBe("persist_failed");
	});
});
