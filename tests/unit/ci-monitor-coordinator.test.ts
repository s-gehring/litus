import { describe, expect, mock, test } from "bun:test";
import type { MonitorResult } from "../../src/ci-monitor";
import { CIMonitorCoordinator } from "../../src/ci-monitor-coordinator";
import type { CiCycle, Workflow } from "../../src/types";
import { makeWorkflow } from "../helpers";

function makeCiCycle(overrides?: Partial<CiCycle>): CiCycle {
	return {
		attempt: 0,
		maxAttempts: 3,
		monitorStartedAt: null,
		globalTimeoutMs: 30 * 60 * 1000,
		lastCheckResults: [],
		failureLogs: [],
		...overrides,
	};
}

// ── startMonitoring ────────────────────────────────────────

describe("startMonitoring", () => {
	test("creates an abort controller and starts monitoring", async () => {
		const mockResult: MonitorResult = { passed: true, timedOut: false, results: [] };
		const mockStartMonitoring = mock(() => Promise.resolve(mockResult));
		const coordinator = new CIMonitorCoordinator(mockStartMonitoring);

		const workflow = makeWorkflow({ prUrl: "https://github.com/org/repo/pull/1" });
		workflow.ciCycle = makeCiCycle();
		const onOutput = mock(() => {});

		const result = await coordinator.startMonitoring(workflow, onOutput);

		expect(result).toEqual(mockResult);
		expect(mockStartMonitoring).toHaveBeenCalledTimes(1);
	});

	test("sets monitorStartedAt if not already set", async () => {
		const mockResult: MonitorResult = { passed: true, timedOut: false, results: [] };
		const coordinator = new CIMonitorCoordinator(mock(() => Promise.resolve(mockResult)));

		const workflow = makeWorkflow({ prUrl: "https://github.com/org/repo/pull/1" });
		workflow.ciCycle = makeCiCycle({ monitorStartedAt: null });
		const onOutput = mock(() => {});

		await coordinator.startMonitoring(workflow, onOutput);

		expect(workflow.ciCycle.monitorStartedAt).not.toBeNull();
	});

	test("preserves existing monitorStartedAt", async () => {
		const mockResult: MonitorResult = { passed: true, timedOut: false, results: [] };
		const coordinator = new CIMonitorCoordinator(mock(() => Promise.resolve(mockResult)));

		const workflow = makeWorkflow({ prUrl: "https://github.com/org/repo/pull/1" });
		const existingTime = "2026-01-01T00:00:00.000Z";
		workflow.ciCycle = makeCiCycle({ monitorStartedAt: existingTime });
		const onOutput = mock(() => {});

		await coordinator.startMonitoring(workflow, onOutput);

		expect(workflow.ciCycle.monitorStartedAt).toBe(existingTime);
	});

	test("passes abort signal to startMonitoring function", async () => {
		let capturedSignal: AbortSignal | undefined;
		const mockStartMonitoring = mock(
			(
				_prUrl: string,
				_ciCycle: CiCycle,
				_onOutput: (msg: string) => void,
				signal?: AbortSignal,
			) => {
				capturedSignal = signal;
				return Promise.resolve({ passed: true, timedOut: false, results: [] } as MonitorResult);
			},
		);
		const coordinator = new CIMonitorCoordinator(mockStartMonitoring);

		const workflow = makeWorkflow({ prUrl: "https://github.com/org/repo/pull/1" });
		const onOutput = mock(() => {});

		await coordinator.startMonitoring(workflow, onOutput);

		expect(capturedSignal).toBeDefined();
		expect(capturedSignal?.aborted).toBe(false);
	});
});

// ── abort / isMonitoring ───────────────────────────────────

describe("abort", () => {
	test("aborts active monitoring", async () => {
		let capturedSignal: AbortSignal | undefined;
		const mockStartMonitoring = mock(
			(
				_prUrl: string,
				_ciCycle: CiCycle,
				_onOutput: (msg: string) => void,
				signal?: AbortSignal,
			) => {
				capturedSignal = signal;
				// Never resolve — simulate long-running monitoring
				return new Promise<MonitorResult>(() => {});
			},
		);
		const coordinator = new CIMonitorCoordinator(mockStartMonitoring);

		const workflow = makeWorkflow({ prUrl: "https://github.com/org/repo/pull/1" });
		const onOutput = mock(() => {});

		// Start but don't await (it never resolves)
		coordinator.startMonitoring(workflow, onOutput);

		expect(coordinator.isMonitoring()).toBe(true);
		coordinator.abort();
		expect(capturedSignal?.aborted).toBe(true);
		expect(coordinator.isMonitoring()).toBe(false);
	});

	test("no-op when not monitoring", () => {
		const coordinator = new CIMonitorCoordinator(mock(() => Promise.resolve({} as MonitorResult)));
		expect(coordinator.isMonitoring()).toBe(false);
		coordinator.abort(); // should not throw
		expect(coordinator.isMonitoring()).toBe(false);
	});
});

describe("isMonitoring", () => {
	test("returns false initially", () => {
		const coordinator = new CIMonitorCoordinator(mock(() => Promise.resolve({} as MonitorResult)));
		expect(coordinator.isMonitoring()).toBe(false);
	});

	test("returns true while monitoring is active", () => {
		const coordinator = new CIMonitorCoordinator(mock(() => new Promise<MonitorResult>(() => {})));
		const workflow = makeWorkflow({ prUrl: "https://github.com/org/repo/pull/1" });
		coordinator.startMonitoring(
			workflow,
			mock(() => {}),
		);
		expect(coordinator.isMonitoring()).toBe(true);
	});

	test("returns false after monitoring completes", async () => {
		const coordinator = new CIMonitorCoordinator(
			mock(() => Promise.resolve({ passed: true, timedOut: false, results: [] } as MonitorResult)),
		);
		const workflow = makeWorkflow({ prUrl: "https://github.com/org/repo/pull/1" });
		await coordinator.startMonitoring(
			workflow,
			mock(() => {}),
		);
		expect(coordinator.isMonitoring()).toBe(false);
	});
});

// ── discoverPrUrl ──────────────────────────────────────────

describe("discoverPrUrl", () => {
	test("delegates PR URL discovery", async () => {
		const mockDiscover = mock(() => Promise.resolve("https://github.com/org/repo/pull/42"));
		const coordinator = new CIMonitorCoordinator(
			mock(() => Promise.resolve({} as MonitorResult)),
			mockDiscover,
		);

		const workflow = makeWorkflow() as Workflow;
		const url = await coordinator.discoverPrUrl(workflow);
		expect(url).toBe("https://github.com/org/repo/pull/42");
		expect(mockDiscover).toHaveBeenCalledWith(workflow);
	});

	test("returns null when no PR found", async () => {
		const mockDiscover = mock(() => Promise.resolve(null));
		const coordinator = new CIMonitorCoordinator(
			mock(() => Promise.resolve({} as MonitorResult)),
			mockDiscover,
		);

		const workflow = makeWorkflow();
		const url = await coordinator.discoverPrUrl(workflow);
		expect(url).toBeNull();
	});
});
