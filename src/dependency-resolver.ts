import type { DependencyGraph, EpicDependencyStatus } from "./types";

interface SpecEdge {
	id: string;
	dependencies: string[];
}

export function buildGraph(specs: SpecEdge[]): DependencyGraph {
	const nodes = specs.map((s) => s.id);
	const edges = new Map<string, string[]>();
	const inDegree = new Map<string, number>();

	for (const node of nodes) {
		edges.set(node, []);
		inDegree.set(node, 0);
	}

	for (const spec of specs) {
		for (const dep of spec.dependencies) {
			// dep -> spec (spec depends on dep)
			edges.get(dep)?.push(spec.id);
			inDegree.set(spec.id, (inDegree.get(spec.id) ?? 0) + 1);
		}
	}

	return { nodes, edges, inDegree };
}

/** Returns null if acyclic, or the list of nodes involved in cycles. */
export function detectCycles(graph: DependencyGraph): string[] | null {
	const inDegree = new Map(graph.inDegree);
	const queue: string[] = [];

	for (const [node, deg] of inDegree) {
		if (deg === 0) queue.push(node);
	}

	let processed = 0;
	while (queue.length > 0) {
		const node = queue.shift()!;
		processed++;
		for (const neighbor of graph.edges.get(node) ?? []) {
			const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
			inDegree.set(neighbor, newDeg);
			if (newDeg === 0) queue.push(neighbor);
		}
	}

	if (processed === graph.nodes.length) return null;

	// Remaining nodes are in cycles
	return graph.nodes.filter((n) => (inDegree.get(n) ?? 0) > 0);
}

/** Returns spec IDs with no incoming dependencies (in-degree 0). */
export function getIndependentSpecs(graph: DependencyGraph): string[] {
	return graph.nodes.filter((n) => (graph.inDegree.get(n) ?? 0) === 0);
}

/** Computes dependency status for a workflow given its dependencies. */
export function computeDependencyStatus(
	dependencies: string[],
	completedIds: Set<string>,
	errorIds: Set<string>,
): { status: EpicDependencyStatus; blocking: string[] } {
	if (dependencies.length === 0) {
		return { status: "satisfied", blocking: [] };
	}

	const blocking: string[] = [];
	let hasError = false;

	for (const dep of dependencies) {
		if (errorIds.has(dep)) {
			hasError = true;
			blocking.push(dep);
		} else if (!completedIds.has(dep)) {
			blocking.push(dep);
		}
	}

	if (blocking.length === 0) {
		return { status: "satisfied", blocking: [] };
	}

	return {
		status: hasError ? "blocked" : "waiting",
		blocking,
	};
}
