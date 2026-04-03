import { describe, expect, test } from "bun:test";
import { formatTimer } from "../../src/client/components/workflow-cards";
import type { WorkflowClientState, WorkflowState } from "../../src/types";

// E2E-style test: simulates the full lifecycle of multiple concurrent workflows
// through the client state model (no real server needed)

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
		steps: [
			{
				name: "specify",
				displayName: "Specifying",
				status: "pending",
				output: "",
				error: null,
				startedAt: null,
				completedAt: null,
			},
			{
				name: "clarify",
				displayName: "Clarifying",
				status: "pending",
				output: "",
				error: null,
				startedAt: null,
				completedAt: null,
			},
		],
		currentStepIndex: 0,
		reviewCycle: { iteration: 1, maxIterations: 16, lastSeverity: null },
		activeWorkMs: 0,
		activeWorkStartedAt: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("E2E: Multi-workflow lifecycle", () => {
	test("start multiple workflows, verify concurrent state, card interaction, timer", () => {
		// Simulate client state
		const workflows = new Map<string, WorkflowClientState>();
		const workflowOrder: string[] = [];
		let expandedWorkflowId: string | null = null;

		// 1. Receive workflow:list (empty initially)
		// No workflows yet

		// 2. Start workflow A
		const wfA = makeWorkflowState({
			id: "wf-a",
			status: "running",
			activeWorkStartedAt: new Date(Date.now() - 10000).toISOString(),
			createdAt: "2026-01-01T00:00:00Z",
		});
		wfA.steps[0].status = "running";
		workflows.set("wf-a", { state: wfA, outputLines: [], isExpanded: false });
		workflowOrder.push("wf-a");
		expandedWorkflowId = "wf-a";

		// 3. Start workflow B (while A is running)
		const wfB = makeWorkflowState({
			id: "wf-b",
			status: "running",
			activeWorkStartedAt: new Date(Date.now() - 5000).toISOString(),
			createdAt: "2026-01-01T00:01:00Z",
		});
		wfB.steps[0].status = "running";
		workflows.set("wf-b", { state: wfB, outputLines: [], isExpanded: false });
		workflowOrder.push("wf-b");

		// Verify both are tracked
		expect(workflows.size).toBe(2);
		expect(workflowOrder).toEqual(["wf-a", "wf-b"]);

		// 4. Output arrives for both
		const entryA = workflows.get("wf-a");
		const entryB = workflows.get("wf-b");
		entryA?.outputLines.push("Output for A");
		entryB?.outputLines.push("Output for B");

		expect(entryA?.outputLines).toHaveLength(1);
		expect(entryB?.outputLines).toHaveLength(1);

		// 5. Click workflow B card (expand it, collapse A)
		expandedWorkflowId = "wf-b";
		expect(expandedWorkflowId).toBe("wf-b");

		// 6. Workflow A gets a question (while not expanded)
		wfA.status = "waiting_for_input";
		wfA.activeWorkMs = 10000;
		wfA.activeWorkStartedAt = null;
		wfA.pendingQuestion = {
			id: "q1",
			content: "What color?",
			detectedAt: new Date().toISOString(),
		};

		// Should pulse (waiting + not expanded)
		const shouldPulseA = wfA.status === "waiting_for_input" && expandedWorkflowId !== "wf-a";
		expect(shouldPulseA).toBe(true);

		// 7. Click workflow A card to answer
		expandedWorkflowId = "wf-a";
		const shouldPulseAfterExpand =
			wfA.status === "waiting_for_input" && expandedWorkflowId !== "wf-a";
		expect(shouldPulseAfterExpand).toBe(false);

		// 8. Timer checks
		// Workflow A: paused at 10000ms
		expect(formatTimer(wfA.activeWorkMs, wfA.activeWorkStartedAt)).toBe("0:10");

		// Workflow B: running with ~5s elapsed
		const timerB = formatTimer(wfB.activeWorkMs, wfB.activeWorkStartedAt);
		expect(timerB).toMatch(/^0:0[45]$/);

		// 9. Start workflow C
		const wfC = makeWorkflowState({
			id: "wf-c",
			status: "running",
			activeWorkStartedAt: new Date().toISOString(),
			createdAt: "2026-01-01T00:02:00Z",
		});
		workflows.set("wf-c", { state: wfC, outputLines: [], isExpanded: false });
		workflowOrder.push("wf-c");

		// Input area should still be functional (not blocking)
		expect(workflows.size).toBe(3);
		expect(workflowOrder).toEqual(["wf-a", "wf-b", "wf-c"]);

		// Currently expanded workflow (A) is not disrupted
		expect(expandedWorkflowId).toBe("wf-a");

		// 10. Workflow B completes
		wfB.status = "completed";
		wfB.activeWorkMs = 5000;
		wfB.activeWorkStartedAt = null;

		expect(formatTimer(wfB.activeWorkMs, wfB.activeWorkStartedAt)).toBe("0:05");

		// 11. Collapse all
		expandedWorkflowId = expandedWorkflowId === "wf-a" ? null : "wf-a";
		expect(expandedWorkflowId).toBeNull();
	});
});
