import { describe, expect, test } from "bun:test";
import { CiMergeFlowController } from "../../src/ci-merge-flow-controller";
import { CIMonitorCoordinator } from "../../src/ci-monitor-coordinator";
import type { MergeResult, Workflow } from "../../src/types";
import { WorkflowEngine } from "../../src/workflow-engine";
import { makeWorkflow } from "../helpers";

describe("CiMergeFlowController", () => {
	test("merge → retry-after-already-up-to-date", async () => {
		const workflow: Workflow = makeWorkflow({
			prUrl: "https://github.com/owner/repo/pull/42",
			worktreePath: "/tmp/wt",
			mergeCycle: { attempt: 1, maxAttempts: 3 },
		});

		const stepOutputCalls: Array<{ id: string; msg: string }> = [];
		const controller = new CiMergeFlowController({
			ciMonitor: new CIMonitorCoordinator(async () => {
				throw new Error("startMonitoring should not run in this test");
			}),
			mergePr: async () =>
				({
					merged: false,
					alreadyMerged: false,
					conflict: true,
					error: null,
				}) satisfies MergeResult,
			resolveConflicts: async () => ({ kind: "already-up-to-date" }),
			syncRepo: async () => ({
				pulled: false,
				skipped: false,
				worktreeRemoved: false,
				warning: null,
			}),
			discoverPrUrl: async () => null,
			stepOutput: (id, msg) => stepOutputCalls.push({ id, msg }),
			engine: new WorkflowEngine(),
		});

		const outcome = await controller.runMergePr(workflow);

		expect(outcome).toEqual({ kind: "retryMergeAfterAlreadyUpToDate" });
		expect(stepOutputCalls.some((c) => c.msg.includes("Local tree already up-to-date"))).toBe(true);
	});

	test("monitor → fix-ci", async () => {
		const workflow = makeWorkflow({
			prUrl: "https://github.com/owner/repo/pull/42",
			worktreePath: "/tmp/wt",
			ciCycle: {
				attempt: 0,
				maxAttempts: 3,
				lastCheckResults: [],
				failureLogs: [],
				monitorStartedAt: null,
				userFixGuidance: null,
				globalTimeoutMs: 60_000,
			},
		});

		const ciMonitor = new CIMonitorCoordinator(async () => ({
			passed: false,
			timedOut: false,
			results: [{ name: "build", state: "failure", bucket: "fail", link: "" }],
		}));

		const controller = new CiMergeFlowController({
			ciMonitor,
			mergePr: async () => ({
				merged: true,
				alreadyMerged: false,
				conflict: false,
				error: null,
			}),
			resolveConflicts: async () => ({ kind: "resolved" }),
			syncRepo: async () => ({
				pulled: false,
				skipped: false,
				worktreeRemoved: false,
				warning: null,
			}),
			discoverPrUrl: async () => workflow.prUrl,
			stepOutput: () => {},
			engine: new WorkflowEngine(),
		});

		const outcome = await controller.runMonitorCi(workflow);
		expect(outcome).toEqual({ kind: "advanceToFixCi" });
	});

	test("merge → sync", async () => {
		const workflow = makeWorkflow({
			prUrl: "https://github.com/owner/repo/pull/42",
			worktreePath: "/tmp/wt",
			mergeCycle: { attempt: 1, maxAttempts: 3 },
		});

		const controller = new CiMergeFlowController({
			ciMonitor: new CIMonitorCoordinator(async () => {
				throw new Error("not used");
			}),
			mergePr: async () => ({
				merged: true,
				alreadyMerged: false,
				conflict: false,
				error: null,
			}),
			resolveConflicts: async () => ({ kind: "resolved" }),
			syncRepo: async () => ({
				pulled: false,
				skipped: false,
				worktreeRemoved: false,
				warning: null,
			}),
			discoverPrUrl: async () => null,
			stepOutput: () => {},
			engine: new WorkflowEngine(),
		});

		const outcome = await controller.runMergePr(workflow);
		expect(outcome).toEqual({ kind: "advance" });
	});
});
