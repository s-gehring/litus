import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ArtifactDescriptor, ArtifactListResponse, PipelineStepName, Workflow } from "./types";

interface ArtifactLookupEntry {
	workflowId: string;
	step: PipelineStepName;
	relPath: string;
	runOrdinal: number | null;
}

// Module-global so minted artifact IDs stay resolvable across HTTP request
// handlers within a single server process (both list and content/download
// endpoints read from this map). Entries are never evicted: acceptable for a
// single-user local app; re-mints are idempotent (same id for same inputs).
const ARTIFACT_LOOKUP = new Map<string, ArtifactLookupEntry>();

export function mintArtifactId(
	workflowId: string,
	step: PipelineStepName,
	relPath: string,
	runOrdinal: number | null,
): string {
	const normalizedRel = relPath.replace(/\\/g, "/");
	const input = `${workflowId}|${step}|${normalizedRel}|${runOrdinal ?? ""}`;
	const hash = createHash("sha256").update(input).digest("hex").slice(0, 16);
	const id = `a_${hash}`;
	ARTIFACT_LOOKUP.set(id, {
		workflowId,
		step,
		relPath: normalizedRel,
		runOrdinal,
	});
	return id;
}

export function lookupArtifact(id: string): ArtifactLookupEntry | null {
	return ARTIFACT_LOOKUP.get(id) ?? null;
}

export function sanitizeBranchForFilename(branch: string): string {
	return branch
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Resolve `relPath` under `specsRoot` and guarantee the result is confined to
 * that root. Returns null on any traversal attempt (absolute input that escapes
 * the root, `..` segments, etc.).
 */
export function resolveArtifactPath(specsRoot: string, relPath: string): string | null {
	const rootAbs = resolve(specsRoot);
	const resolved = resolve(rootAbs, relPath);
	if (resolved !== rootAbs && !resolved.startsWith(rootAbs + sep)) return null;
	return resolved;
}

export function getWorkflowBranch(
	workflow: Pick<Workflow, "featureBranch" | "worktreeBranch">,
): string {
	return workflow.featureBranch ?? workflow.worktreeBranch;
}

export function getSpecsRoot(
	workflow: Pick<Workflow, "worktreePath" | "featureBranch" | "worktreeBranch">,
): string | null {
	const branch = getWorkflowBranch(workflow);
	if (!workflow.worktreePath || !branch) return null;
	return join(workflow.worktreePath, "specs", branch);
}

function collectMdFilesRecursive(absDir: string, relPrefix: string, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(absDir);
	} catch {
		return;
	}
	for (const name of entries) {
		const abs = join(absDir, name);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(abs);
		} catch {
			continue;
		}
		const relName = relPrefix ? `${relPrefix}/${name}` : name;
		if (stat.isDirectory()) {
			collectMdFilesRecursive(abs, relName, out);
		} else if (stat.isFile() && name.endsWith(".md")) {
			out.push(relName);
		}
	}
}

interface ReviewFile {
	ordinal: number;
	name: string;
}

function scanReviewFiles(specsRoot: string): ReviewFile[] {
	if (!existsSync(specsRoot)) return [];
	let entries: string[];
	try {
		entries = readdirSync(specsRoot);
	} catch {
		return [];
	}
	const files: ReviewFile[] = [];
	for (const name of entries) {
		if (name === "code-review.md") {
			files.push({ ordinal: 1, name });
			continue;
		}
		const m = name.match(/^code-review-(\d+)\.md$/);
		if (m) {
			const n = parseInt(m[1], 10);
			if (n >= 1) files.push({ ordinal: n, name });
		}
	}
	files.sort((a, b) => a.ordinal - b.ordinal);
	return files;
}

function buildDescriptor(
	workflowId: string,
	step: PipelineStepName,
	relPath: string,
	affordanceLabel: string,
	displayLabel: string,
	absolutePath: string,
	runOrdinal: number | null,
): ArtifactDescriptor | null {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(absolutePath);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;
	const id = mintArtifactId(workflowId, step, relPath, runOrdinal);
	return {
		id,
		step,
		displayLabel,
		affordanceLabel,
		relPath: relPath.replace(/\\/g, "/"),
		sizeBytes: stat.size,
		lastModified: stat.mtime.toISOString(),
		exists: true,
		runOrdinal,
	};
}

const PLAN_BASE_FILES = ["plan.md", "research.md", "data-model.md", "quickstart.md"] as const;

const STEP_ORDER: PipelineStepName[] = [
	"specify",
	"clarify",
	"plan",
	"tasks",
	"review",
	"implement-review",
];

function completedImplementReviewRuns(workflow: Workflow): number {
	const impl = workflow.steps.find((s) => s.name === "implement-review");
	if (!impl) return 0;
	const current = impl.status === "completed" ? 1 : 0;
	return impl.history.filter((h) => h.status === "completed").length + current;
}

function clarifyHasRun(workflow: Workflow): boolean {
	const step = workflow.steps.find((s) => s.name === "clarify");
	if (!step) return false;
	if (step.status === "completed") return true;
	return step.history.some((h) => h.status === "completed");
}

export function listArtifacts(workflow: Workflow): ArtifactListResponse {
	const branch = getWorkflowBranch(workflow);
	const specsRoot = getSpecsRoot(workflow);
	if (!specsRoot || !existsSync(specsRoot)) {
		return { workflowId: workflow.id, branch, items: [] };
	}

	const items: ArtifactDescriptor[] = [];
	const add = (
		step: PipelineStepName,
		relPath: string,
		aff: string,
		disp: string,
		ord: number | null,
	) => {
		const abs = resolveArtifactPath(specsRoot, relPath);
		if (!abs) return;
		const d = buildDescriptor(workflow.id, step, relPath, aff, disp, abs, ord);
		if (d) items.push(d);
	};

	add("specify", "spec.md", "View spec", "spec.md", null);
	if (clarifyHasRun(workflow)) {
		add("clarify", "spec.md", "View spec with clarifications", "spec.md", null);
	}

	for (const rel of PLAN_BASE_FILES) {
		add("plan", rel, "View plan artifact", rel, null);
	}
	const contractsAbs = join(specsRoot, "contracts");
	if (existsSync(contractsAbs)) {
		const contractMds: string[] = [];
		collectMdFilesRecursive(contractsAbs, "contracts", contractMds);
		contractMds.sort();
		for (const rel of contractMds) {
			add("plan", rel, "View plan artifact", rel, null);
		}
	}

	add("tasks", "tasks.md", "View tasks", "tasks.md", null);

	const reviewFiles = scanReviewFiles(specsRoot);
	for (const rf of reviewFiles) {
		add("review", rf.name, "View review", rf.name, rf.ordinal);
	}

	const implCompleted = completedImplementReviewRuns(workflow);
	for (const rf of reviewFiles) {
		if (rf.ordinal <= implCompleted) {
			add("implement-review", rf.name, "View review with fixes", rf.name, rf.ordinal);
		}
	}

	items.sort((a, b) => {
		const sa = STEP_ORDER.indexOf(a.step);
		const sb = STEP_ORDER.indexOf(b.step);
		if (sa !== sb) return sa - sb;
		if (a.runOrdinal != null && b.runOrdinal != null && a.runOrdinal !== b.runOrdinal) {
			return a.runOrdinal - b.runOrdinal;
		}
		if (a.relPath !== b.relPath) return a.relPath < b.relPath ? -1 : 1;
		return 0;
	});

	return { workflowId: workflow.id, branch, items };
}
