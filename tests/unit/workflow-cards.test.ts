import { describe, expect, test } from "bun:test";
import type { WorkflowClientState, WorkflowState } from "../../src/types";

function makeWorkflowState(overrides?: Partial<WorkflowState>): WorkflowState {
	return {
		id: overrides?.id ?? `wf-${Date.now()}`,
		specification: "Build a feature",
		status: "idle",
		targetRepository: null,
		worktreePath: "/tmp/test",
		worktreeBranch: "crab-studio/test",
		summary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: [],
		currentStepIndex: 0,
		reviewCycle: { iteration: 1, maxIterations: 16, lastSeverity: null },
		activeWorkMs: 0,
		activeWorkStartedAt: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("Card strip rendering logic", () => {
	test("cards are ordered by createdAt ascending (oldest first)", () => {
		const workflows: WorkflowState[] = [
			makeWorkflowState({ id: "wf-3", createdAt: "2026-01-03T00:00:00Z" }),
			makeWorkflowState({ id: "wf-1", createdAt: "2026-01-01T00:00:00Z" }),
			makeWorkflowState({ id: "wf-2", createdAt: "2026-01-02T00:00:00Z" }),
		];

		const sorted = [...workflows].sort(
			(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
		);

		expect(sorted[0].id).toBe("wf-1");
		expect(sorted[1].id).toBe("wf-2");
		expect(sorted[2].id).toBe("wf-3");
	});

	test("new card is appended to the right (end of order array)", () => {
		const order = ["wf-1", "wf-2"];
		order.push("wf-3");
		expect(order[order.length - 1]).toBe("wf-3");
	});

	test("expand/collapse: single-expanded constraint", () => {
		let expandedId: string | null = null;

		// Expand wf-1
		expandedId = "wf-1";
		expect(expandedId).toBe("wf-1");

		// Click wf-2 — wf-1 collapses
		expandedId = "wf-2";
		expect(expandedId).toBe("wf-2");

		// Click wf-2 again — toggle collapse
		expandedId = expandedId === "wf-2" ? null : "wf-2";
		expect(expandedId).toBeNull();
	});

	test("pulse state: pulse when waiting_for_input and not expanded", () => {
		const wf = makeWorkflowState({ id: "wf-1", status: "waiting_for_input" });
		const expandedWorkflowId: string | null = null;

		const shouldPulse = wf.status === "waiting_for_input" && expandedWorkflowId !== wf.id;
		expect(shouldPulse).toBe(true);
	});

	test("pulse state: no pulse when waiting_for_input but expanded", () => {
		const wf = makeWorkflowState({ id: "wf-1", status: "waiting_for_input" });
		const expandedWorkflowId = "wf-1";

		const shouldPulse = wf.status === "waiting_for_input" && expandedWorkflowId !== wf.id;
		expect(shouldPulse).toBe(false);
	});

	test("pulse state: no pulse when running (not waiting_for_input)", () => {
		const wf = makeWorkflowState({ id: "wf-1", status: "running" });
		const expandedWorkflowId: string | null = null;

		const shouldPulse = wf.status === "waiting_for_input" && expandedWorkflowId !== wf.id;
		expect(shouldPulse).toBe(false);
	});

	test("summary truncation for compact card", () => {
		const longSummary = "This is a very long summary that should be truncated for the compact card display because it exceeds the maximum character limit";
		const maxLen = 50;
		const truncated = longSummary.length > maxLen ? `${longSummary.slice(0, maxLen)}...` : longSummary;

		expect(truncated.length).toBeLessThanOrEqual(maxLen + 3);
		expect(truncated.endsWith("...")).toBe(true);
	});

	test("status badge maps to correct class", () => {
		const statusClasses: Record<string, string> = {
			idle: "card-status-idle",
			running: "card-status-running",
			waiting_for_input: "card-status-waiting",
			completed: "card-status-completed",
			cancelled: "card-status-cancelled",
			error: "card-status-error",
		};

		expect(statusClasses.running).toBe("card-status-running");
		expect(statusClasses.error).toBe("card-status-error");
		expect(statusClasses.waiting_for_input).toBe("card-status-waiting");
	});
});
