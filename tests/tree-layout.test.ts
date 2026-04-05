import { describe, expect, test } from "bun:test";
import {
	computeTreeEdges,
	computeTreeLayout,
	type TreeNode,
} from "../src/client/components/epic-tree";
import type { WorkflowState } from "../src/types";

function makeWf(overrides: Partial<WorkflowState> & { id: string }): WorkflowState {
	return {
		id: overrides.id,
		specification: overrides.specification ?? "test spec",
		status: overrides.status ?? "idle",
		targetRepository: null,
		worktreePath: null,
		worktreeBranch: "test-branch",
		summary: overrides.summary ?? overrides.id,
		stepSummary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: [],
		currentStepIndex: 0,
		reviewCycle: { iteration: 0, maxIterations: 3, lastSeverity: null },
		ciCycle: {
			attempt: 0,
			maxAttempts: 3,
			monitorStartedAt: null,
			globalTimeoutMs: 600000,
			lastCheckResults: [],
			failureLogs: [],
		},
		mergeCycle: { attempt: 0, maxAttempts: 3 },
		prUrl: null,
		epicId: "epic-1",
		epicTitle: "Test Epic",
		epicDependencies: overrides.epicDependencies ?? [],
		epicDependencyStatus: overrides.epicDependencyStatus ?? null,
		activeWorkMs: 0,
		activeWorkStartedAt: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

describe("computeTreeLayout", () => {
	test("empty workflows returns empty nodes", () => {
		expect(computeTreeLayout([])).toEqual([]);
	});

	test("single node gets rank 0", () => {
		const nodes = computeTreeLayout([makeWf({ id: "a" })]);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].rank).toBe(0);
		expect(nodes[0].indexInRank).toBe(0);
	});

	test("linear chain assigns increasing ranks", () => {
		const workflows = [
			makeWf({ id: "a", summary: "A", epicDependencies: [] }),
			makeWf({ id: "b", summary: "B", epicDependencies: ["a"] }),
			makeWf({ id: "c", summary: "C", epicDependencies: ["b"] }),
		];
		const nodes = computeTreeLayout(workflows);
		const nodeMap = new Map(nodes.map((n) => [n.workflowId, n]));

		expect(nodeMap.get("a")?.rank).toBe(0);
		expect(nodeMap.get("b")?.rank).toBe(1);
		expect(nodeMap.get("c")?.rank).toBe(2);
	});

	test("multiple roots at rank 0", () => {
		const workflows = [
			makeWf({ id: "a", summary: "A", epicDependencies: [] }),
			makeWf({ id: "b", summary: "B", epicDependencies: [] }),
			makeWf({ id: "c", summary: "C", epicDependencies: ["a", "b"] }),
		];
		const nodes = computeTreeLayout(workflows);
		const nodeMap = new Map(nodes.map((n) => [n.workflowId, n]));

		expect(nodeMap.get("a")?.rank).toBe(0);
		expect(nodeMap.get("b")?.rank).toBe(0);
		expect(nodeMap.get("c")?.rank).toBe(1);
	});

	test("diamond dependency pattern", () => {
		// A -> B, A -> C, B -> D, C -> D
		const workflows = [
			makeWf({ id: "a", summary: "A", epicDependencies: [] }),
			makeWf({ id: "b", summary: "B", epicDependencies: ["a"] }),
			makeWf({ id: "c", summary: "C", epicDependencies: ["a"] }),
			makeWf({ id: "d", summary: "D", epicDependencies: ["b", "c"] }),
		];
		const nodes = computeTreeLayout(workflows);
		const nodeMap = new Map(nodes.map((n) => [n.workflowId, n]));

		expect(nodeMap.get("a")?.rank).toBe(0);
		expect(nodeMap.get("b")?.rank).toBe(1);
		expect(nodeMap.get("c")?.rank).toBe(1);
		expect(nodeMap.get("d")?.rank).toBe(2);
	});

	test("nodes within same rank are sorted alphabetically", () => {
		const workflows = [
			makeWf({ id: "c", summary: "Charlie", epicDependencies: [] }),
			makeWf({ id: "a", summary: "Alpha", epicDependencies: [] }),
			makeWf({ id: "b", summary: "Bravo", epicDependencies: [] }),
		];
		const nodes = computeTreeLayout(workflows);
		const rank0 = nodes.filter((n) => n.rank === 0);

		expect(rank0[0].workflowId).toBe("a");
		expect(rank0[1].workflowId).toBe("b");
		expect(rank0[2].workflowId).toBe("c");
	});

	test("x position increases with rank", () => {
		const workflows = [
			makeWf({ id: "a", epicDependencies: [] }),
			makeWf({ id: "b", epicDependencies: ["a"] }),
		];
		const nodes = computeTreeLayout(workflows);
		const nodeMap = new Map(nodes.map((n) => [n.workflowId, n]));

		expect(nodeMap.get("b")?.x).toBeGreaterThan(nodeMap.get("a")?.x ?? 0);
	});

	test("y position increases within rank", () => {
		const workflows = [
			makeWf({ id: "a", summary: "A", epicDependencies: [] }),
			makeWf({ id: "b", summary: "B", epicDependencies: [] }),
		];
		const nodes = computeTreeLayout(workflows);
		const rank0 = nodes.filter((n) => n.rank === 0);

		expect(rank0[1].y).toBeGreaterThan(rank0[0].y);
	});
});

describe("computeTreeEdges", () => {
	test("no dependencies means no edges", () => {
		const nodes: TreeNode[] = [
			{ workflowId: "a", rank: 0, indexInRank: 0, x: 0, y: 0, dependencies: [] },
		];
		const edges = computeTreeEdges(nodes, new Map());
		expect(edges).toEqual([]);
	});

	test("creates edges for dependencies", () => {
		const nodes: TreeNode[] = [
			{ workflowId: "a", rank: 0, indexInRank: 0, x: 0, y: 0, dependencies: [] },
			{ workflowId: "b", rank: 1, indexInRank: 0, x: 220, y: 0, dependencies: ["a"] },
		];
		const wfMap = new Map<string, WorkflowState>([
			["a", makeWf({ id: "a", status: "completed" })],
			["b", makeWf({ id: "b", status: "idle" })],
		]);
		const edges = computeTreeEdges(nodes, wfMap);

		expect(edges).toHaveLength(1);
		expect(edges[0].from).toBe("a");
		expect(edges[0].to).toBe("b");
		expect(edges[0].status).toBe("satisfied");
	});

	test("edge status is waiting when dependency is running", () => {
		const nodes: TreeNode[] = [
			{ workflowId: "a", rank: 0, indexInRank: 0, x: 0, y: 0, dependencies: [] },
			{ workflowId: "b", rank: 1, indexInRank: 0, x: 220, y: 0, dependencies: ["a"] },
		];
		const wfMap = new Map<string, WorkflowState>([
			["a", makeWf({ id: "a", status: "running" })],
			["b", makeWf({ id: "b", status: "waiting_for_dependencies" })],
		]);
		const edges = computeTreeEdges(nodes, wfMap);
		expect(edges[0].status).toBe("waiting");
	});

	test("edge status is blocked when dependency errored", () => {
		const nodes: TreeNode[] = [
			{ workflowId: "a", rank: 0, indexInRank: 0, x: 0, y: 0, dependencies: [] },
			{ workflowId: "b", rank: 1, indexInRank: 0, x: 220, y: 0, dependencies: ["a"] },
		];
		const wfMap = new Map<string, WorkflowState>([
			["a", makeWf({ id: "a", status: "error" })],
			["b", makeWf({ id: "b", status: "waiting_for_dependencies" })],
		]);
		const edges = computeTreeEdges(nodes, wfMap);
		expect(edges[0].status).toBe("blocked");
	});

	test("diamond pattern produces 4 edges", () => {
		const nodes: TreeNode[] = [
			{ workflowId: "a", rank: 0, indexInRank: 0, x: 0, y: 0, dependencies: [] },
			{ workflowId: "b", rank: 1, indexInRank: 0, x: 220, y: 0, dependencies: ["a"] },
			{ workflowId: "c", rank: 1, indexInRank: 1, x: 220, y: 90, dependencies: ["a"] },
			{ workflowId: "d", rank: 2, indexInRank: 0, x: 440, y: 0, dependencies: ["b", "c"] },
		];
		const wfMap = new Map<string, WorkflowState>([
			["a", makeWf({ id: "a", status: "completed" })],
			["b", makeWf({ id: "b", status: "completed" })],
			["c", makeWf({ id: "c", status: "running" })],
			["d", makeWf({ id: "d", status: "waiting_for_dependencies" })],
		]);
		const edges = computeTreeEdges(nodes, wfMap);
		expect(edges).toHaveLength(4);

		const dEdges = edges.filter((e) => e.to === "d");
		expect(dEdges).toHaveLength(2);
		expect(dEdges.find((e) => e.from === "b")?.status).toBe("satisfied");
		expect(dEdges.find((e) => e.from === "c")?.status).toBe("waiting");
	});
});
