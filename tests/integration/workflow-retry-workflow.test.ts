import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleRetryWorkflow } from "../../src/server/workflow-handlers";
import type { ServerMessage, Workflow } from "../../src/types";
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

function makeDeps(workflow: Workflow | null) {
	const sent: SentMessage[] = [];
	const broadcasts: string[] = [];
	const saved: Workflow[] = [];
	const auditEvents: Record<string, unknown>[] = [];
	const createdOrchestrators: Array<{ getEngine: () => { setWorkflow: (w: Workflow) => void } }> =
		[];

	const orchestrators = new Map<
		string,
		{ getEngine: () => { setWorkflow: (w: Workflow) => void } }
	>();

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
			const orch = {
				getEngine: () => ({
					setWorkflow: (_w: Workflow) => {},
				}),
			};
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
