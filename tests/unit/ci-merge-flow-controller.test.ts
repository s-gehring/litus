import { describe, expect, test } from "bun:test";
import { CiMergeFlowController } from "../../src/ci-merge-flow-controller";
import type { MonitorResult } from "../../src/ci-monitor";
import { CIMonitorCoordinator } from "../../src/ci-monitor-coordinator";
import type { MergeResult, Workflow } from "../../src/types";
import { WorkflowEngine } from "../../src/workflow-engine";
import { makeWorkflow } from "../helpers";

type ControllerOptions = ConstructorParameters<typeof CiMergeFlowController>[0];

type ControllerOverrides = {
	startMonitoring?: () => Promise<MonitorResult>;
	mergePr?: ControllerOptions["mergePr"];
	resolveConflicts?: ControllerOptions["resolveConflicts"];
	syncRepo?: ControllerOptions["syncRepo"];
	discoverPrUrl?: ControllerOptions["discoverPrUrl"];
	stepOutput?: ControllerOptions["stepOutput"];
};

function makeController(overrides: ControllerOverrides = {}): CiMergeFlowController {
	const startMonitoring =
		overrides.startMonitoring ??
		(async () => {
			throw new Error("startMonitoring not stubbed in this test");
		});
	return new CiMergeFlowController({
		ciMonitor: new CIMonitorCoordinator(startMonitoring),
		mergePr:
			overrides.mergePr ??
			(async () =>
				({
					merged: true,
					alreadyMerged: false,
					conflict: false,
					error: null,
				}) satisfies MergeResult),
		resolveConflicts: overrides.resolveConflicts ?? (async () => ({ kind: "resolved" })),
		syncRepo:
			overrides.syncRepo ??
			(async () => ({
				pulled: false,
				skipped: false,
				worktreeRemoved: false,
				warning: null,
			})),
		discoverPrUrl: overrides.discoverPrUrl ?? (async () => null),
		stepOutput: overrides.stepOutput ?? (() => {}),
		engine: new WorkflowEngine(),
	});
}

describe("CiMergeFlowController", () => {
	test("merge → retry-after-already-up-to-date", async () => {
		const workflow: Workflow = makeWorkflow({
			prUrl: "https://github.com/owner/repo/pull/42",
			worktreePath: "/tmp/wt",
			mergeCycle: { attempt: 1, maxAttempts: 3 },
		});

		const stepOutputCalls: Array<{ id: string; msg: string }> = [];
		const controller = makeController({
			mergePr: async () =>
				({
					merged: false,
					alreadyMerged: false,
					conflict: true,
					error: null,
				}) satisfies MergeResult,
			resolveConflicts: async () => ({ kind: "already-up-to-date" }),
			stepOutput: (id, msg) => stepOutputCalls.push({ id, msg }),
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

		const controller = makeController({
			startMonitoring: async () => ({
				passed: false,
				timedOut: false,
				results: [{ name: "build", state: "failure", bucket: "fail", link: "" }],
			}),
			discoverPrUrl: async () => workflow.prUrl,
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

		const controller = makeController({
			mergePr: async () => ({
				merged: true,
				alreadyMerged: false,
				conflict: false,
				error: null,
			}),
		});

		const outcome = await controller.runMergePr(workflow);
		expect(outcome).toEqual({ kind: "advance" });
	});

	// --- handleMonitorResult branches ---

	test("handleMonitorResult: max attempts exhausted → error", async () => {
		const workflow = makeWorkflow({
			ciCycle: {
				attempt: 99,
				maxAttempts: 3,
				lastCheckResults: [],
				failureLogs: [],
				monitorStartedAt: null,
				userFixGuidance: null,
				globalTimeoutMs: 60_000,
			},
		});
		const controller = makeController();
		const outcome = controller.handleMonitorResult(workflow, {
			passed: false,
			timedOut: false,
			results: [{ name: "build", state: "failure", bucket: "fail", link: "" }],
		});
		expect(outcome.kind).toBe("error");
	});

	test("handleMonitorResult: all checks cancelled → pauseForQuestion", async () => {
		const workflow = makeWorkflow({
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
		const controller = makeController();
		const outcome = controller.handleMonitorResult(workflow, {
			passed: false,
			timedOut: false,
			results: [{ name: "build", state: "cancelled", bucket: "cancel", link: "" }],
		});
		expect(outcome.kind).toBe("pauseForQuestion");
		if (outcome.kind === "pauseForQuestion") {
			expect(outcome.question.content).toContain("All failed CI checks were cancelled");
		}
	});

	// --- runMonitorCi PR-URL discovery branches ---

	test("runMonitorCi: null prUrl + discoverPrUrl returns null → error", async () => {
		const workflow = makeWorkflow({ prUrl: null });
		const controller = makeController({ discoverPrUrl: async () => null });
		const outcome = await controller.runMonitorCi(workflow);
		expect(outcome.kind).toBe("error");
	});

	test("runMonitorCi: null prUrl + discoverPrUrl resolves → workflow.prUrl set", async () => {
		const workflow = makeWorkflow({ prUrl: null });
		const discovered = "https://github.com/owner/repo/pull/7";
		const controller = makeController({
			discoverPrUrl: async () => discovered,
			startMonitoring: async () => ({
				passed: true,
				timedOut: false,
				results: [],
			}),
		});
		const outcome = await controller.runMonitorCi(workflow);
		expect(workflow.prUrl).toBe(discovered);
		expect(outcome.kind).toBe("advance");
	});

	// --- runFixCi branches ---

	test("runFixCi: null prUrl → error", async () => {
		const workflow = makeWorkflow({ prUrl: null });
		const controller = makeController();
		const outcome = await controller.runFixCi(workflow);
		expect(outcome.kind).toBe("error");
	});

	test("runFixCi: happy path returns runCliStep with prompt + guidance", async () => {
		const workflow = makeWorkflow({
			prUrl: "https://github.com/owner/repo/pull/42",
			ciCycle: {
				attempt: 1,
				maxAttempts: 3,
				lastCheckResults: [], // empty → gatherAllFailureLogs returns [] (no network)
				failureLogs: [],
				monitorStartedAt: null,
				userFixGuidance: "focus on the flaky integration test",
				globalTimeoutMs: 60_000,
			},
		});
		const controller = makeController();
		const outcome = await controller.runFixCi(workflow);
		expect(outcome.kind).toBe("runCliStep");
		if (outcome.kind === "runCliStep") {
			expect(outcome.prompt).toContain("USER GUIDANCE");
			expect(outcome.prompt).toContain("focus on the flaky integration test");
			expect(outcome.clearUserFixGuidance).toBe(true);
			expect(outcome.failureLogs).toEqual([]);
		}
	});

	// --- handleMergeResult branches ---

	test("handleMergeResult: exhausted merge attempts → error", async () => {
		const workflow = makeWorkflow({
			worktreePath: "/tmp/wt",
			mergeCycle: { attempt: 3, maxAttempts: 3 },
		});
		const controller = makeController();
		const outcome = await controller.handleMergeResult(workflow, {
			merged: false,
			alreadyMerged: false,
			conflict: true,
			error: null,
		});
		expect(outcome.kind).toBe("error");
	});

	test("handleMergeResult: conflict resolved → routeBackToMonitor with incrementMergeAttempt", async () => {
		const workflow = makeWorkflow({
			worktreePath: "/tmp/wt",
			mergeCycle: { attempt: 1, maxAttempts: 3 },
		});
		const controller = makeController({
			resolveConflicts: async () => ({ kind: "resolved" }),
		});
		const outcome = await controller.handleMergeResult(workflow, {
			merged: false,
			alreadyMerged: false,
			conflict: true,
			error: null,
		});
		expect(outcome).toEqual({ kind: "routeBackToMonitor", incrementMergeAttempt: true });
	});

	// --- retryMergeAfterAlreadyUpToDate branches ---

	test("retryMergeAfterAlreadyUpToDate: success → advance", async () => {
		const workflow = makeWorkflow({
			prUrl: "https://github.com/owner/repo/pull/42",
			worktreePath: "/tmp/wt",
		});
		const controller = makeController({
			mergePr: async () => ({
				merged: true,
				alreadyMerged: false,
				conflict: false,
				error: null,
			}),
		});
		const outcome = await controller.retryMergeAfterAlreadyUpToDate(workflow);
		expect(outcome).toEqual({ kind: "advance" });
	});

	test("retryMergeAfterAlreadyUpToDate: persistent conflict → error", async () => {
		const workflow = makeWorkflow({
			prUrl: "https://github.com/owner/repo/pull/42",
			worktreePath: "/tmp/wt",
		});
		const controller = makeController({
			mergePr: async () => ({
				merged: false,
				alreadyMerged: false,
				conflict: true,
				error: null,
			}),
		});
		const outcome = await controller.retryMergeAfterAlreadyUpToDate(workflow);
		expect(outcome.kind).toBe("error");
		if (outcome.kind === "error") {
			expect(outcome.message).toContain("squash-merge");
		}
	});

	// --- runSyncRepo error absorption ---

	test("runSyncRepo: syncRepoFn error is absorbed and emits a warning", async () => {
		const workflow = makeWorkflow();
		const stepOutputCalls: string[] = [];
		const controller = makeController({
			syncRepo: async () => {
				throw new Error("git push exploded");
			},
			stepOutput: (_id, msg) => stepOutputCalls.push(msg),
		});
		const outcome = await controller.runSyncRepo(workflow);
		expect(outcome).toEqual({ kind: "advance" });
		expect(stepOutputCalls.some((m) => m.includes("sync failed"))).toBe(true);
	});

	// --- answerMonitorCancelledQuestion branches (H2) ---

	test("answerMonitorCancelledQuestion: 'abort' → error", async () => {
		const workflow = makeWorkflow();
		const controller = makeController();
		const outcome = await controller.answerMonitorCancelledQuestion(workflow, "abort");
		expect(outcome.kind).toBe("error");
	});

	test("answerMonitorCancelledQuestion: free-form text → guidance + advanceToFixCi", async () => {
		const workflow = makeWorkflow();
		const controller = makeController();
		const outcome = await controller.answerMonitorCancelledQuestion(
			workflow,
			"  please rerun checks #5 only  ",
		);
		expect(outcome).toEqual({ kind: "advanceToFixCi" });
		expect(workflow.ciCycle.userFixGuidance).toBe("please rerun checks #5 only");
	});

	test("answerMonitorCancelledQuestion: 'retry' → re-enters runMonitorCi", async () => {
		const workflow = makeWorkflow({ prUrl: "https://github.com/owner/repo/pull/42" });
		const controller = makeController({
			startMonitoring: async () => ({
				passed: true,
				timedOut: false,
				results: [],
			}),
		});
		const outcome = await controller.answerMonitorCancelledQuestion(workflow, "retry");
		expect(outcome).toEqual({ kind: "advance" });
	});
});
