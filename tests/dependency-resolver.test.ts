import { describe, expect, test } from "bun:test";
import {
	buildGraph,
	computeDependencyStatus,
	detectCycles,
	getIndependentSpecs,
} from "../src/dependency-resolver";

describe("buildGraph", () => {
	test("builds graph from specs", () => {
		const specs = [
			{ id: "a", dependencies: [] },
			{ id: "b", dependencies: ["a"] },
			{ id: "c", dependencies: ["a", "b"] },
		];
		const graph = buildGraph(specs);
		expect(graph.nodes).toEqual(["a", "b", "c"]);
		expect(graph.edges.get("a")).toEqual(["b", "c"]);
		expect(graph.edges.get("b")).toEqual(["c"]);
		expect(graph.edges.get("c")).toEqual([]);
		expect(graph.inDegree.get("a")).toBe(0);
		expect(graph.inDegree.get("b")).toBe(1);
		expect(graph.inDegree.get("c")).toBe(2);
	});

	test("handles empty specs", () => {
		const graph = buildGraph([]);
		expect(graph.nodes).toEqual([]);
		expect(graph.edges.size).toBe(0);
	});
});

describe("detectCycles", () => {
	test("returns null for acyclic graph", () => {
		const specs = [
			{ id: "a", dependencies: [] },
			{ id: "b", dependencies: ["a"] },
			{ id: "c", dependencies: ["b"] },
		];
		const graph = buildGraph(specs);
		expect(detectCycles(graph)).toBeNull();
	});

	test("detects simple cycle (a -> b -> a)", () => {
		const specs = [
			{ id: "a", dependencies: ["b"] },
			{ id: "b", dependencies: ["a"] },
		];
		const graph = buildGraph(specs);
		const cycle = detectCycles(graph);
		expect(cycle).not.toBeNull();
		expect(cycle).toContain("a");
		expect(cycle).toContain("b");
	});

	test("detects cycle in larger graph", () => {
		const specs = [
			{ id: "a", dependencies: [] },
			{ id: "b", dependencies: ["a", "c"] },
			{ id: "c", dependencies: ["b"] },
		];
		const graph = buildGraph(specs);
		const cycle = detectCycles(graph);
		expect(cycle).not.toBeNull();
		expect(cycle).toContain("b");
		expect(cycle).toContain("c");
	});

	test("returns null for single node", () => {
		const graph = buildGraph([{ id: "a", dependencies: [] }]);
		expect(detectCycles(graph)).toBeNull();
	});
});

describe("getIndependentSpecs", () => {
	test("returns specs with in-degree 0", () => {
		const specs = [
			{ id: "a", dependencies: [] },
			{ id: "b", dependencies: ["a"] },
			{ id: "c", dependencies: [] },
		];
		const graph = buildGraph(specs);
		const independent = getIndependentSpecs(graph);
		expect(independent.sort()).toEqual(["a", "c"]);
	});

	test("returns all specs when no dependencies", () => {
		const specs = [
			{ id: "a", dependencies: [] },
			{ id: "b", dependencies: [] },
		];
		const graph = buildGraph(specs);
		expect(getIndependentSpecs(graph).sort()).toEqual(["a", "b"]);
	});

	test("returns empty array when all have dependencies", () => {
		const specs = [
			{ id: "a", dependencies: ["b"] },
			{ id: "b", dependencies: ["a"] },
		];
		const graph = buildGraph(specs);
		expect(getIndependentSpecs(graph)).toEqual([]);
	});
});

describe("computeDependencyStatus", () => {
	test("returns satisfied when all dependencies completed", () => {
		const completedIds = new Set(["dep-1", "dep-2"]);
		const errorIds = new Set<string>();
		const status = computeDependencyStatus(["dep-1", "dep-2"], completedIds, errorIds);
		expect(status.status).toBe("satisfied");
		expect(status.blocking).toEqual([]);
	});

	test("returns waiting when some dependencies incomplete", () => {
		const completedIds = new Set(["dep-1"]);
		const errorIds = new Set<string>();
		const status = computeDependencyStatus(["dep-1", "dep-2"], completedIds, errorIds);
		expect(status.status).toBe("waiting");
		expect(status.blocking).toEqual(["dep-2"]);
	});

	test("returns blocked when a dependency errored", () => {
		const completedIds = new Set(["dep-1"]);
		const errorIds = new Set(["dep-2"]);
		const status = computeDependencyStatus(["dep-1", "dep-2"], completedIds, errorIds);
		expect(status.status).toBe("blocked");
		expect(status.blocking).toEqual(["dep-2"]);
	});

	test("returns satisfied when no dependencies", () => {
		const status = computeDependencyStatus([], new Set(), new Set());
		expect(status.status).toBe("satisfied");
		expect(status.blocking).toEqual([]);
	});
});
