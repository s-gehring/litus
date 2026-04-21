import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
	type ArtifactsManifest,
	type ManifestParseError,
	parseArtifactsManifest,
} from "./artifacts-manifest";
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

// Files considered "contract artifacts" when the plan step snapshots
// `contracts/**`. Allows common text/spec formats alongside a few binary image
// types so scenarios that ship e.g. a reference `pixel.png` diagram under
// contracts/ are surfaced in the Planning dropdown and downloadable verbatim.
const CONTRACT_ARTIFACT_EXTS = new Set([
	".md",
	".txt",
	".json",
	".yaml",
	".yml",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".svg",
]);

function isContractArtifactFilename(name: string): boolean {
	const dot = name.lastIndexOf(".");
	if (dot < 0) return false;
	return CONTRACT_ARTIFACT_EXTS.has(name.slice(dot).toLowerCase());
}

function collectContractFilesRecursive(absDir: string, relPrefix: string, out: string[]): void {
	collectFilesRecursive(absDir, relPrefix, out, isContractArtifactFilename);
}

function collectFilesRecursive(
	absDir: string,
	relPrefix: string,
	out: string[],
	accept: (name: string) => boolean,
): void {
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
			collectFilesRecursive(abs, relName, out, accept);
		} else if (stat.isFile() && accept(name)) {
			out.push(relName);
		}
	}
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
	"artifacts",
];

// Filename used for the descriptions sidecar persisted next to artifacts-step
// files. Keyed by the manifest `path` (same key that's used for the on-disk
// rel path). Out-of-band from the artifact files themselves so preview /
// download endpoints don't need to know about it.
const ARTIFACTS_DESCRIPTIONS_FILE = "descriptions.json";

interface PersistedDescriptionEntry {
	description: string;
	contentType?: string;
}

type PersistedDescriptions = Record<string, PersistedDescriptionEntry>;

function readDescriptionsSidecar(workflowId: string): PersistedDescriptions {
	const stepDir = join(getArtifactsRoot(workflowId), "artifacts", "_");
	const file = join(stepDir, ARTIFACTS_DESCRIPTIONS_FILE);
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as PersistedDescriptions;
		}
	} catch (err) {
		logger.warn(`[artifacts] Failed to read descriptions sidecar ${file}: ${String(err)}`);
	}
	return {};
}

function writeDescriptionsSidecar(workflowId: string, entries: PersistedDescriptions): void {
	const stepDir = join(getArtifactsRoot(workflowId), "artifacts", "_");
	mkdirSync(stepDir, { recursive: true });
	const file = join(stepDir, ARTIFACTS_DESCRIPTIONS_FILE);
	writeFileSync(file, JSON.stringify(entries, null, 2));
}

export type ArtifactsCollectionOutcome = "with-files" | "empty" | "error";

export type ArtifactsCollectionErrorKind =
	| "manifest-missing"
	| "manifest-invalid"
	| "manifest-file-missing";

export interface ArtifactsRejection {
	relPath: string;
	reason: "file-cap-exceeded" | "step-cap-exceeded";
	sizeBytes: number;
}

export interface ArtifactsCollectionResult {
	outcome: ArtifactsCollectionOutcome;
	accepted: Array<{ relPath: string; sizeBytes: number; description: string }>;
	rejections: ArtifactsRejection[];
	errorKind: ArtifactsCollectionErrorKind | null;
	errorMessage: string | null;
}

export interface ArtifactsCollectionCaps {
	perFileMaxBytes: number;
	perStepMaxBytes: number;
}

function errorResult(
	kind: ArtifactsCollectionErrorKind,
	message: string,
): ArtifactsCollectionResult {
	return {
		outcome: "error",
		accepted: [],
		rejections: [],
		errorKind: kind,
		errorMessage: message,
	};
}

function formatManifestError(err: ManifestParseError): string {
	return err.kind === "invalid-json"
		? `Manifest JSON is not parseable: ${err.message}`
		: `Manifest failed schema validation at ${err.at}: ${err.message}`;
}

/**
 * Read and validate `<outputDir>/manifest.json`, then copy each listed file
 * into the persistent artifact store under step `"artifacts"` (ordinal `_`).
 * Hard failures (missing/invalid manifest, a manifest entry pointing at a
 * file that does not exist on disk) leave the store untouched. Per-file and
 * per-step cap overflows are soft rejections: the oversized file is skipped
 * but other accepted files are still persisted (FR-013b, FR-013c).
 */
export function collectArtifactsFromManifest(
	workflow: Pick<Workflow, "id">,
	outputDir: string,
	caps: ArtifactsCollectionCaps,
): ArtifactsCollectionResult {
	const manifestPath = join(outputDir, "manifest.json");
	if (!existsSync(manifestPath)) {
		return errorResult("manifest-missing", `No manifest.json found at ${manifestPath}`);
	}

	let rawText: string;
	try {
		rawText = readFileSync(manifestPath, "utf-8");
	} catch (err) {
		return errorResult(
			"manifest-invalid",
			`Failed to read manifest.json: ${(err as Error).message}`,
		);
	}

	const parsed = parseArtifactsManifest(rawText);
	if (!parsed.ok || !parsed.manifest) {
		const message = parsed.error ? formatManifestError(parsed.error) : "manifest parse failed";
		return errorResult("manifest-invalid", message);
	}

	const manifest: ArtifactsManifest = parsed.manifest;

	// Pre-flight: resolve every manifest path, confirm it exists and fits the
	// traversal guard, and record its size. Missing files abort atomically so
	// the store is not touched with a half-complete set.
	interface Resolved {
		relPath: string;
		normalizedRel: string;
		src: string;
		description: string;
		contentType?: string;
		sizeBytes: number;
	}

	const resolvedEntries: Resolved[] = [];
	for (const entry of manifest.artifacts) {
		const src = resolveArtifactPath(outputDir, entry.path);
		if (!src) {
			return errorResult(
				"manifest-invalid",
				`Manifest entry ${JSON.stringify(entry.path)} escapes the output directory`,
			);
		}
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(src);
		} catch {
			return errorResult(
				"manifest-file-missing",
				`Manifest entry ${JSON.stringify(entry.path)} does not exist on disk`,
			);
		}
		if (!stat.isFile()) {
			return errorResult(
				"manifest-file-missing",
				`Manifest entry ${JSON.stringify(entry.path)} is not a regular file`,
			);
		}
		resolvedEntries.push({
			relPath: entry.path,
			normalizedRel: entry.path.replace(/\\/g, "/"),
			src,
			description: entry.description,
			contentType: entry.contentType,
			sizeBytes: stat.size,
		});
	}

	// Soft rejection pass: enforce per-file and per-step caps.
	const rejections: ArtifactsRejection[] = [];
	const toCopy: Resolved[] = [];
	let runningTotal = 0;
	for (const r of resolvedEntries) {
		if (r.sizeBytes > caps.perFileMaxBytes) {
			rejections.push({
				relPath: r.normalizedRel,
				reason: "file-cap-exceeded",
				sizeBytes: r.sizeBytes,
			});
			continue;
		}
		if (runningTotal + r.sizeBytes > caps.perStepMaxBytes) {
			rejections.push({
				relPath: r.normalizedRel,
				reason: "step-cap-exceeded",
				sizeBytes: r.sizeBytes,
			});
			continue;
		}
		toCopy.push(r);
		runningTotal += r.sizeBytes;
	}

	// Persist accepted files and descriptions sidecar.
	const accepted: ArtifactsCollectionResult["accepted"] = [];
	const descriptions: PersistedDescriptions = {};
	for (const r of toCopy) {
		const dest = getArtifactSnapshotPath(workflow.id, "artifacts", null, r.relPath);
		if (!dest) {
			// Already validated above — reaching here means the store root itself
			// escaped traversal, which is a bug, not a manifest issue.
			return errorResult(
				"manifest-invalid",
				`Resolved destination for ${JSON.stringify(r.relPath)} escapes the artifacts root`,
			);
		}
		try {
			mkdirSync(dirname(dest), { recursive: true });
			copyFileSync(r.src, dest);
		} catch (err) {
			logger.warn(`[artifacts] Failed to copy ${r.src} -> ${dest}: ${String(err)}`);
			return errorResult(
				"manifest-file-missing",
				`Failed to copy ${r.relPath}: ${(err as Error).message}`,
			);
		}
		accepted.push({
			relPath: r.normalizedRel,
			sizeBytes: r.sizeBytes,
			description: r.description,
		});
		descriptions[r.normalizedRel] = { description: r.description, contentType: r.contentType };
	}

	if (accepted.length > 0) {
		writeDescriptionsSidecar(workflow.id, descriptions);
	}

	return {
		outcome: accepted.length > 0 ? "with-files" : "empty",
		accepted,
		rejections,
		errorKind: null,
		errorMessage: null,
	};
}

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
					const files: string[] = [];
					collectContractFilesRecursive(contractsAbs, "contracts", files);
					for (const rel of files) snap(rel, null);
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

function listFilesInStepDir(
	stepDir: string,
	accept: (name: string) => boolean = (n) => n.endsWith(".md"),
): {
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
			collectFilesRecursive(abs, "", out, accept);
			direct.push(...out);
		} else if (/^\d+$/.test(name)) {
			const ord = parseInt(name, 10);
			const out: string[] = [];
			collectFilesRecursive(abs, "", out, accept);
			byOrdinal.set(ord, out);
		}
	}
	return { direct, byOrdinal };
}

function planStepAccept(name: string): boolean {
	// Plan step lists both the canonical `.md` outputs (plan.md, research.md,
	// etc) and any contract artifacts that were snapshotted under `contracts/`
	// (which may include binary types like `.png`).
	return name.endsWith(".md") || isContractArtifactFilename(name);
}

function artifactsStepAccept(name: string): boolean {
	// Artifacts step accepts any file type (FR-002). The descriptions sidecar
	// lives in the same dir but is not a user-facing artifact.
	return name !== ARTIFACTS_DESCRIPTIONS_FILE;
}

/**
 * Recursively remove every file under the workflow's persistent artifact root
 * and return a `{ removed, failed }` summary. Missing root → `{ removed: 0,
 * failed: [] }` so callers can treat "already gone" as success (FR-008). Each
 * unlink error is captured by absolute path in `failed[]` so the caller can
 * name them in the partial-failure audit/UI message (FR-009). The root
 * directory itself is removed on success (best effort — directory removal
 * failures are ignored because `failed[]` already accurately describes any
 * files still present).
 */
export function clearArtifacts(workflowId: string): { removed: number; failed: string[] } {
	const root = getArtifactsRoot(workflowId);
	if (!existsSync(root)) return { removed: 0, failed: [] };

	const failed: string[] = [];
	let removed = 0;

	function walk(dir: string): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (err) {
			failed.push(dir);
			logger.warn(`[artifacts] Failed to read dir during clear: ${dir}: ${String(err)}`);
			return;
		}
		for (const name of entries) {
			const abs = join(dir, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(abs);
			} catch {
				failed.push(abs);
				continue;
			}
			if (st.isDirectory()) {
				walk(abs);
			} else {
				try {
					unlinkSync(abs);
					removed++;
				} catch (err) {
					failed.push(abs);
					logger.warn(`[artifacts] Failed to unlink ${abs}: ${String(err)}`);
				}
			}
		}
	}

	walk(root);

	if (failed.length === 0) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch (err) {
			logger.warn(`[artifacts] Failed to remove artifact root ${root}: ${String(err)}`);
		}
	}

	return { removed, failed };
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
		extras?: { description?: string; contentType?: string },
	) => {
		const abs = getArtifactSnapshotPath(workflow.id, step, runOrdinal, relPath);
		if (!abs) return;
		const d = buildDescriptor(workflow.id, step, relPath, displayLabel, abs, runOrdinal);
		if (!d) return;
		if (extras?.description) d.description = extras.description;
		if (extras?.contentType) d.contentType = extras.contentType;
		items.push(d);
	};

	const artifactsDescriptions = existsSync(join(root, "artifacts"))
		? readDescriptionsSidecar(workflow.id)
		: {};

	// Enumerate from the persistent snapshot store. The workflow state no
	// longer gates visibility — a snapshot's existence is the authoritative
	// signal that the step produced it.
	for (const step of STEP_ORDER) {
		const stepDir = join(root, step);
		const acceptFor =
			step === "plan" ? planStepAccept : step === "artifacts" ? artifactsStepAccept : undefined;
		const { direct, byOrdinal } = listFilesInStepDir(stepDir, acceptFor);

		if (step === "specify" || step === "clarify") {
			const label = step === "clarify" ? "spec.md (clarified)" : "spec.md";
			for (const rel of direct) push(step, rel, label, null);
		} else if (step === "plan") {
			const sorted = [...direct].sort();
			for (const rel of sorted) push(step, rel, rel, null);
		} else if (step === "tasks") {
			for (const rel of direct) push(step, rel, rel, null);
		} else if (step === "artifacts") {
			const sorted = [...direct].sort();
			for (const rel of sorted) {
				const meta = artifactsDescriptions[rel];
				push(step, rel, rel, null, meta);
			}
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
