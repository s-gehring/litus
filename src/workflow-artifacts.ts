import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { logger } from "./logger";
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
 * Resolve `relPath` under `root` and guarantee the result is confined to
 * that root. Returns null on any traversal attempt (absolute input that escapes
 * the root, `..` segments, etc.).
 */
export function resolveArtifactPath(root: string, relPath: string): string | null {
	const rootAbs = resolve(root);
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

/**
 * Persistent artifact snapshot root under $HOME/.litus/artifacts/<workflowId>/.
 * Survives worktree deletion so archived workflows retain their artifacts.
 */
export function getArtifactsRoot(workflowId: string): string {
	return join(homedir(), ".litus", "artifacts", workflowId);
}

function ordinalSegment(runOrdinal: number | null): string {
	return runOrdinal == null ? "_" : String(runOrdinal);
}

/**
 * Full path to one snapshotted artifact file within the persistent store.
 */
export function getArtifactSnapshotPath(
	workflowId: string,
	step: PipelineStepName,
	runOrdinal: number | null,
	relPath: string,
): string | null {
	const stepDir = join(getArtifactsRoot(workflowId), step, ordinalSegment(runOrdinal));
	return resolveArtifactPath(stepDir, relPath);
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

function scanReviewFiles(dir: string): ReviewFile[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
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
		affordanceLabel: "Artifacts",
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

function copyIfExists(srcAbs: string, destAbs: string): boolean {
	try {
		if (!statSync(srcAbs).isFile()) return false;
	} catch {
		return false;
	}
	try {
		mkdirSync(dirname(destAbs), { recursive: true });
		copyFileSync(srcAbs, destAbs);
		return true;
	} catch (err) {
		logger.warn(`[artifacts] Failed to snapshot ${srcAbs} -> ${destAbs}: ${String(err)}`);
		return false;
	}
}

function snapshotFile(
	workflowId: string,
	step: PipelineStepName,
	runOrdinal: number | null,
	specsRoot: string,
	relPath: string,
): void {
	const src = resolveArtifactPath(specsRoot, relPath);
	if (!src || !existsSync(src)) return;
	const dest = getArtifactSnapshotPath(workflowId, step, runOrdinal, relPath);
	if (!dest) return;
	copyIfExists(src, dest);
}

/**
 * Copy the current state of files produced/modified by `step` from the
 * workflow's specs/ dir into the persistent snapshot store. Call this at step
 * completion so later steps (and worktree deletion) cannot rewrite the artifact.
 */
export function snapshotStepArtifacts(
	workflow: Pick<Workflow, "id" | "worktreePath" | "featureBranch" | "worktreeBranch"> & {
		reviewCycle?: { iteration: number };
	},
	step: PipelineStepName,
): void {
	const specsRoot = getSpecsRoot(workflow);
	if (!specsRoot || !existsSync(specsRoot)) return;

	const snap = (relPath: string, runOrdinal: number | null) =>
		snapshotFile(workflow.id, step, runOrdinal, specsRoot, relPath);

	switch (step) {
		case "specify":
		case "clarify":
			snap("spec.md", null);
			break;
		case "plan":
			for (const rel of PLAN_BASE_FILES) snap(rel, null);
			{
				const contractsAbs = join(specsRoot, "contracts");
				if (existsSync(contractsAbs)) {
					const mds: string[] = [];
					collectMdFilesRecursive(contractsAbs, "contracts", mds);
					for (const rel of mds) snap(rel, null);
				}
			}
			break;
		case "tasks":
			snap("tasks.md", null);
			break;
		case "review":
		case "implement-review": {
			const ordinal = Math.max(1, workflow.reviewCycle?.iteration ?? 1);
			const relPath = ordinal === 1 ? "code-review.md" : `code-review-${ordinal}.md`;
			snap(relPath, ordinal);
			break;
		}
		default:
			break;
	}
}

function listFilesInStepDir(stepDir: string): {
	direct: string[];
	byOrdinal: Map<number, string[]>;
} {
	const direct: string[] = [];
	const byOrdinal = new Map<number, string[]>();
	if (!existsSync(stepDir)) return { direct, byOrdinal };
	let entries: string[];
	try {
		entries = readdirSync(stepDir);
	} catch {
		return { direct, byOrdinal };
	}
	for (const name of entries) {
		const abs = join(stepDir, name);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(abs);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		if (name === "_") {
			const out: string[] = [];
			collectMdFilesRecursive(abs, "", out);
			direct.push(...out);
		} else if (/^\d+$/.test(name)) {
			const ord = parseInt(name, 10);
			const out: string[] = [];
			collectMdFilesRecursive(abs, "", out);
			byOrdinal.set(ord, out);
		}
	}
	return { direct, byOrdinal };
}

export function listArtifacts(workflow: Workflow): ArtifactListResponse {
	const branch = getWorkflowBranch(workflow);
	const root = getArtifactsRoot(workflow.id);
	const items: ArtifactDescriptor[] = [];

	if (!existsSync(root)) {
		return { workflowId: workflow.id, branch, items };
	}

	const push = (
		step: PipelineStepName,
		relPath: string,
		displayLabel: string,
		runOrdinal: number | null,
	) => {
		const abs = getArtifactSnapshotPath(workflow.id, step, runOrdinal, relPath);
		if (!abs) return;
		const d = buildDescriptor(workflow.id, step, relPath, displayLabel, abs, runOrdinal);
		if (d) items.push(d);
	};

	// Enumerate from the persistent snapshot store. The workflow state no
	// longer gates visibility — a snapshot's existence is the authoritative
	// signal that the step produced it.
	for (const step of STEP_ORDER) {
		const stepDir = join(root, step);
		const { direct, byOrdinal } = listFilesInStepDir(stepDir);

		if (step === "specify" || step === "clarify") {
			const label = step === "clarify" ? "spec.md (clarified)" : "spec.md";
			for (const rel of direct) push(step, rel, label, null);
		} else if (step === "plan") {
			const sorted = [...direct].sort();
			for (const rel of sorted) push(step, rel, rel, null);
		} else if (step === "tasks") {
			for (const rel of direct) push(step, rel, rel, null);
		} else if (step === "review" || step === "implement-review") {
			const ordinals = [...byOrdinal.keys()].sort((a, b) => a - b);
			for (const ord of ordinals) {
				const files = byOrdinal.get(ord) ?? [];
				for (const rel of files) {
					const label = step === "implement-review" ? `${rel} (after fixes)` : rel;
					push(step, rel, label, ord);
				}
			}
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
