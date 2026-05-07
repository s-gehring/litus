// Locks in the CI poll broadcast cadence required by the icon-row feature.
// Backs contract O-1, O-2, O-3 in
// `specs/001-ci-pipeline-status-view/contracts/poll-update-broadcast.md`:
//
//   O-1  every successful poll fires `onStateChange(workflowId)` after
//        `lastCheckResults` is updated;
//   O-2  a poll error does NOT fire `onStateChange`;
//   O-3  a fresh attempt clears `lastCheckResults` to `[]` before the
//        rollover broadcast.

import { describe, expect, test } from "bun:test";
import { CiMergeFlowController } from "../../src/ci-merge-flow-controller";
import type { MonitorResult } from "../../src/ci-monitor";
import { CIMonitorCoordinator } from "../../src/ci-monitor-coordinator";
import type { CiCheckResult, CiCycle } from "../../src/types";
import { WorkflowEngine } from "../../src/workflow-engine";
import { makeWorkflow } from "../helpers";

type StartMonitoringFn = (
	prUrl: string,
	ciCycle: CiCycle,
	onOutput: (msg: string) => void,
	signal?: AbortSignal,
	onPollComplete?: () => void,
) => Promise<MonitorResult>;

function makeController(
	startMonitoring: StartMonitoringFn,
	onStateChange?: (id: string) => void,
): CiMergeFlowController {
	return new CiMergeFlowController({
		ciMonitor: new CIMonitorCoordinator(startMonitoring),
		mergePr: async () => ({ merged: true, alreadyMerged: false, conflict: false, error: null }),
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
		onStateChange,
	});
}

describe("pipeline-orchestrator CI poll broadcast cadence", () => {
	test("onStateChange fires once per successful poll inside the monitor-ci adapter", async () => {
		const broadcasts: string[] = [];
		const polls: CiCheckResult[][] = [
			[{ name: "build", state: "in_progress", bucket: "pending", link: "" }],
			[{ name: "build", state: "success", bucket: "pass", link: "" }],
		];

		const startMonitoring: StartMonitoringFn = async (_url, ciCycle, _out, _signal, onPoll) => {
			for (const results of polls) {
				ciCycle.lastCheckResults = results;
				onPoll?.();
			}
			return { passed: true, timedOut: false, results: polls[polls.length - 1] };
		};

		const controller = makeController(startMonitoring, (id) => broadcasts.push(id));
		const workflow = makeWorkflow({
			id: "wf-poll",
			prUrl: "https://github.com/owner/repo/pull/1",
		});
		// Fresh-attempt reset already broadcast once before polling begins.
		await controller.runMonitorCi(workflow);

		// 1 attempt-rollover broadcast + 2 poll broadcasts = 3 total.
		expect(broadcasts).toEqual(["wf-poll", "wf-poll", "wf-poll"]);
	});

	test("onStateChange does NOT fire on poll error", async () => {
		const broadcasts: string[] = [];

		const startMonitoring: StartMonitoringFn = async (_url, ciCycle, _out, _signal, onPoll) => {
			// Simulate one successful poll then one transient error: the
			// successful poll calls onPoll, the error path inside the real
			// `startMonitoring` does not. Mimic that contract here.
			ciCycle.lastCheckResults = [{ name: "build", state: "queued", bucket: "pending", link: "" }];
			onPoll?.();
			// An error path would intentionally skip `onPoll?.()` — assert by
			// returning without firing again.
			return {
				passed: false,
				timedOut: false,
				results: ciCycle.lastCheckResults,
			};
		};

		const controller = makeController(startMonitoring, (id) => broadcasts.push(id));
		const workflow = makeWorkflow({
			id: "wf-err",
			prUrl: "https://github.com/owner/repo/pull/1",
		});
		await controller.runMonitorCi(workflow);

		// 1 attempt-rollover + 1 successful poll = 2. The (mock) error path
		// after that produced no broadcast.
		expect(broadcasts).toEqual(["wf-err", "wf-err"]);
	});

	test("attempt-rollover broadcast: lastCheckResults is [] at the moment of broadcast", async () => {
		// The fresh-attempt clear runs synchronously before startMonitoringFn is
		// called, so we can observe the cleared state from inside the
		// onStateChange callback.
		const observed: { lastCheckResults: CiCheckResult[] }[] = [];

		const workflow = makeWorkflow({
			id: "wf-rollover",
			prUrl: "https://github.com/owner/repo/pull/1",
			ciCycle: {
				attempt: 1,
				maxAttempts: 3,
				monitorStartedAt: null, // post-fix-ci re-entry: pipeline-orchestrator nulls this
				globalTimeoutMs: 60_000,
				// Stale entries from the prior attempt — the contract requires
				// these be cleared before the rollover broadcast.
				lastCheckResults: [{ name: "build", state: "failure", bucket: "fail", link: "" }],
				failureLogs: [],
			},
		});

		const startMonitoring: StartMonitoringFn = async () => ({
			passed: true,
			timedOut: false,
			results: [],
		});

		const controller = makeController(startMonitoring, () => {
			observed.push({ lastCheckResults: [...workflow.ciCycle.lastCheckResults] });
		});

		await controller.runMonitorCi(workflow);

		// First (rollover) broadcast must show an empty results array.
		expect(observed.length).toBeGreaterThan(0);
		expect(observed[0].lastCheckResults).toEqual([]);
	});

	test("rollover does NOT clear lastCheckResults on a continuation entry (monitorStartedAt already set)", async () => {
		// Cancelled-question retry path: runMonitorCi is re-invoked while
		// monitorStartedAt is still populated. The icons should stay until
		// the next poll lands a fresh result set.
		const broadcasts: string[] = [];
		const stable: CiCheckResult[] = [
			{ name: "build", state: "in_progress", bucket: "pending", link: "" },
		];

		const workflow = makeWorkflow({
			id: "wf-retry",
			prUrl: "https://github.com/owner/repo/pull/1",
			ciCycle: {
				attempt: 0,
				maxAttempts: 3,
				monitorStartedAt: new Date().toISOString(),
				globalTimeoutMs: 60_000,
				lastCheckResults: stable,
				failureLogs: [],
			},
		});

		const startMonitoring: StartMonitoringFn = async () => ({
			passed: true,
			timedOut: false,
			results: stable,
		});

		const controller = makeController(startMonitoring, (id) => broadcasts.push(id));
		await controller.runMonitorCi(workflow);

		// No rollover broadcast (continuation), and the prior entries are
		// still in place at function entry.
		expect(broadcasts).toEqual([]);
		expect(workflow.ciCycle.lastCheckResults).toEqual(stable);
	});
});
