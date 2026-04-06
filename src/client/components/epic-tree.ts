import type { EpicAggregatedState, WorkflowState } from "../../types";
import { STATUS_CLASSES, STATUS_LABELS } from "./status-maps";
import { formatTimer } from "./workflow-cards";

export interface TreeNode {
	workflowId: string;
	rank: number;
	indexInRank: number;
	x: number;
	y: number;
	dependencies: string[];
}

export interface TreeEdge {
	from: string;
	to: string;
	status: "satisfied" | "waiting" | "blocked";
}

const COLUMN_WIDTH = 250;
const ROW_HEIGHT = 88;
const NODE_WIDTH = 190;
const NODE_HEIGHT = 78;
const PADDING_X = 20;
const PADDING_Y = 15;

export function computeTreeLayout(workflows: WorkflowState[]): TreeNode[] {
	if (workflows.length === 0) return [];

	// Build adjacency: workflowId -> its epicDependencies
	const depsMap = new Map<string, string[]>();
	for (const wf of workflows) {
		depsMap.set(wf.id, wf.epicDependencies ?? []);
	}

	// Compute rank via longest-path from roots
	const ranks = new Map<string, number>();

	function computeRank(id: string, visited: Set<string>): number {
		const cached = ranks.get(id);
		if (cached !== undefined) return cached;
		if (visited.has(id)) return 0; // cycle guard
		visited.add(id);

		const deps = depsMap.get(id) ?? [];
		if (deps.length === 0) {
			ranks.set(id, 0);
			return 0;
		}

		let maxDepRank = 0;
		for (const dep of deps) {
			if (depsMap.has(dep)) {
				maxDepRank = Math.max(maxDepRank, computeRank(dep, visited) + 1);
			}
		}
		ranks.set(id, maxDepRank);
		return maxDepRank;
	}

	for (const wf of workflows) {
		computeRank(wf.id, new Set());
	}

	// Group by rank, sort within rank alphabetically by summary
	const byRank = new Map<number, WorkflowState[]>();
	for (const wf of workflows) {
		const rank = ranks.get(wf.id) ?? 0;
		if (!byRank.has(rank)) byRank.set(rank, []);
		byRank.get(rank)?.push(wf);
	}

	for (const [, group] of byRank) {
		group.sort((a, b) =>
			(a.summary || a.specification).localeCompare(b.summary || b.specification),
		);
	}

	// Compute positions
	const nodes: TreeNode[] = [];
	for (const [rank, group] of byRank) {
		for (let i = 0; i < group.length; i++) {
			const wf = group[i];
			nodes.push({
				workflowId: wf.id,
				rank,
				indexInRank: i,
				x: PADDING_X + rank * COLUMN_WIDTH,
				y: PADDING_Y + i * ROW_HEIGHT,
				dependencies: (wf.epicDependencies ?? []).filter((d) => depsMap.has(d)),
			});
		}
	}

	return nodes;
}

export function computeTreeEdges(
	nodes: TreeNode[],
	workflows: Map<string, WorkflowState>,
): TreeEdge[] {
	const edges: TreeEdge[] = [];
	for (const node of nodes) {
		for (const depId of node.dependencies) {
			const depWf = workflows.get(depId);
			let status: TreeEdge["status"] = "waiting";
			if (depWf) {
				if (depWf.status === "completed") status = "satisfied";
				else if (depWf.status === "error" || depWf.status === "cancelled") status = "blocked";
			}
			edges.push({ from: depId, to: node.workflowId, status });
		}
	}
	return edges;
}

const EDGE_COLORS: Record<TreeEdge["status"], string> = {
	satisfied: "#4ecca3",
	waiting: "#8888aa",
	blocked: "#e94560",
};

export function renderSvgConnectors(nodes: TreeNode[], edges: TreeEdge[]): SVGSVGElement {
	const nodeMap = new Map<string, TreeNode>();
	for (const n of nodes) nodeMap.set(n.workflowId, n);

	// Compute SVG size
	let maxX = 0;
	let maxY = 0;
	for (const n of nodes) {
		maxX = Math.max(maxX, n.x + NODE_WIDTH + PADDING_X);
		maxY = Math.max(maxY, n.y + NODE_HEIGHT + PADDING_Y);
	}

	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", "tree-svg");
	svg.setAttribute("width", String(maxX));
	svg.setAttribute("height", String(maxY));

	for (const edge of edges) {
		const fromNode = nodeMap.get(edge.from);
		const toNode = nodeMap.get(edge.to);
		if (!fromNode || !toNode) continue;

		const x1 = fromNode.x + NODE_WIDTH;
		const y1 = fromNode.y + NODE_HEIGHT / 2;
		const x2 = toNode.x;
		const y2 = toNode.y + NODE_HEIGHT / 2;
		const dx = (x2 - x1) * 0.4;

		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", `M ${x1},${y1} C ${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
		path.setAttribute("stroke", EDGE_COLORS[edge.status]);
		path.setAttribute("stroke-width", "2");
		path.setAttribute("fill", "none");
		path.setAttribute("data-from", edge.from);
		path.setAttribute("data-to", edge.to);
		svg.appendChild(path);
	}

	return svg;
}

export function renderTreeNode(
	node: TreeNode,
	workflow: WorkflowState,
	onClick: (workflowId: string) => void,
): HTMLElement {
	const el = document.createElement("div");
	el.className = "tree-node";
	el.style.left = `${node.x}px`;
	el.style.top = `${node.y}px`;
	el.style.width = `${NODE_WIDTH}px`;
	el.style.height = `${NODE_HEIGHT}px`;
	el.dataset.workflowId = node.workflowId;

	const badge = document.createElement("span");
	badge.className = `card-status ${STATUS_CLASSES[workflow.status] || "card-status-idle"}`;
	badge.textContent = STATUS_LABELS[workflow.status] || workflow.status;
	el.appendChild(badge);

	const title = document.createElement("span");
	title.className = "tree-node-title";
	const titleText = workflow.summary || workflow.specification;
	title.textContent = titleText;
	title.title = titleText;
	el.appendChild(title);

	// Info row: step name (left) + working time (right)
	const isActive = workflow.status === "running" || workflow.status === "waiting_for_input";
	const hasTimer = workflow.activeWorkMs > 0 || workflow.activeWorkStartedAt;
	if (isActive || hasTimer) {
		const infoRow = document.createElement("div");
		infoRow.className = "tree-node-info";

		if (isActive && workflow.steps.length > 0) {
			const currentStep = workflow.steps[workflow.currentStepIndex];
			if (currentStep) {
				const stepEl = document.createElement("span");
				stepEl.className = "tree-node-step";
				stepEl.textContent = currentStep.displayName;
				infoRow.appendChild(stepEl);
			}
		}

		if (hasTimer) {
			const timerEl = document.createElement("span");
			timerEl.className = "card-timer tree-node-timer";
			timerEl.dataset.activeWorkMs = String(workflow.activeWorkMs);
			timerEl.dataset.activeWorkStartedAt = workflow.activeWorkStartedAt || "";
			timerEl.textContent = formatTimer(workflow.activeWorkMs, workflow.activeWorkStartedAt);
			infoRow.appendChild(timerEl);
		}

		el.appendChild(infoRow);
	}

	el.addEventListener("click", (e) => {
		e.stopPropagation();
		onClick(node.workflowId);
	});

	// Highlight dependencies on hover
	el.addEventListener("mouseenter", () => {
		const container = el.closest(".epic-tree-container");
		if (!container) return;

		// Collect all related workflow IDs (this node + all its dependencies, recursively)
		const related = new Set<string>();
		related.add(node.workflowId);
		function collectDeps(id: string) {
			const n = container?.querySelector(`.tree-node[data-workflow-id="${id}"]`);
			if (!n) return;
			// Find edges pointing to this node
			const svg = container?.querySelector(".tree-svg");
			if (!svg) return;
			for (const path of svg.querySelectorAll(`path[data-to="${id}"]`)) {
				const fromId = path.getAttribute("data-from");
				if (fromId && !related.has(fromId)) {
					related.add(fromId);
					collectDeps(fromId);
				}
			}
		}
		collectDeps(node.workflowId);

		// Dim all nodes and edges, then highlight related ones
		container.classList.add("tree-hovering");
		for (const n of container.querySelectorAll(".tree-node")) {
			const nId = (n as HTMLElement).dataset.workflowId;
			n.classList.toggle("tree-node-highlighted", related.has(nId ?? ""));
			n.classList.toggle("tree-node-dimmed", !related.has(nId ?? ""));
		}
		const svg = container.querySelector(".tree-svg");
		if (svg) {
			for (const path of svg.querySelectorAll("path")) {
				const from = path.getAttribute("data-from");
				const to = path.getAttribute("data-to");
				const isRelated = related.has(from ?? "") && related.has(to ?? "");
				path.classList.toggle("tree-edge-highlighted", isRelated);
				path.classList.toggle("tree-edge-dimmed", !isRelated);
			}
		}
	});

	el.addEventListener("mouseleave", () => {
		const container = el.closest(".epic-tree-container");
		if (!container) return;
		container.classList.remove("tree-hovering");
		for (const n of container.querySelectorAll(".tree-node")) {
			n.classList.remove("tree-node-highlighted", "tree-node-dimmed");
		}
		const svg = container.querySelector(".tree-svg");
		if (svg) {
			for (const path of svg.querySelectorAll("path")) {
				path.classList.remove("tree-edge-highlighted", "tree-edge-dimmed");
			}
		}
	});

	return el;
}

export function renderEpicTree(
	epicState: EpicAggregatedState,
	workflows: Map<string, WorkflowState>,
	onChildClick: (workflowId: string) => void,
): HTMLElement {
	const container = document.createElement("div");
	container.className = "epic-tree-container";

	// Gather child workflows
	const childWorkflows: WorkflowState[] = [];
	for (const id of epicState.childWorkflowIds) {
		const wf = workflows.get(id);
		if (wf) childWorkflows.push(wf);
	}

	if (childWorkflows.length === 0) {
		const empty = document.createElement("div");
		empty.className = "tree-empty";
		empty.textContent = "No child specifications found.";
		container.appendChild(empty);
		return container;
	}

	const nodes = computeTreeLayout(childWorkflows);
	const edges = computeTreeEdges(nodes, workflows);

	// SVG connector layer
	const svg = renderSvgConnectors(nodes, edges);
	container.appendChild(svg);

	// Node cards
	for (const node of nodes) {
		const wf = workflows.get(node.workflowId);
		if (wf) {
			container.appendChild(renderTreeNode(node, wf, onChildClick));
		}
	}

	// Set container size
	let maxX = 0;
	let maxY = 0;
	for (const n of nodes) {
		maxX = Math.max(maxX, n.x + NODE_WIDTH + PADDING_X);
		maxY = Math.max(maxY, n.y + NODE_HEIGHT + PADDING_Y);
	}
	container.style.minWidth = `${maxX}px`;
	container.style.minHeight = `${maxY}px`;

	return container;
}
