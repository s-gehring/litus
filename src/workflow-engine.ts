import { randomUUID } from "node:crypto";
import { cp, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configStore } from "./config-store";
import { gitSpawn } from "./git-logger";
import {
	getStepDefinitionByName,
	getStepDefinitionsForKind,
	VALID_TRANSITIONS as transitions,
	type WorkflowStatus,
} from "./pipeline-steps";
import {
	ASK_QUESTION_MAX_LENGTH,
	type EpicAnalysisResult,
	type Question,
	type Workflow,
	type WorkflowKind,
} from "./types";
import { clearArtifacts } from "./workflow-artifacts";

/**
 * Outcome of a workflow reset attempt. Each target reports independently so a
 * partial failure can name exactly which artifacts could not be cleaned up
 * (FR-009). `partialFailure` is derived: true iff any target failed.
 */
export interface ResetOutcome {
	branch: { ok: true } | { ok: false; error: string; name: string };
	worktree: { ok: true } | { ok: false; error: string; path: string };
	artifacts: { ok: true; removed: number } | { ok: false; removed: number; failed: string[] };
	partialFailure: boolean;
}

function isWorktreeMissing(stderr: string): boolean {
	// `git worktree remove` emits e.g. "fatal: '<path>' is not a working tree" or
	// "fatal: <path> does not exist" when the target is already gone. Treat
	// either phrasing as idempotent success.
	return (
		/is not a working tree/i.test(stderr) ||
		/does not exist/i.test(stderr) ||
		/No such file or directory/i.test(stderr)
	);
}

function isBranchMissing(stderr: string): boolean {
	// `git branch -D <name>` emits "error: branch '<name>' not found." when the
	// branch has already been deleted. Treat as idempotent success.
	return /not found/i.test(stderr) || /No such/i.test(stderr);
}

// On Windows, `git worktree move` (which calls MoveFileEx underneath) fails with
// "Permission denied" if any process holds an open handle to a file in the
// source dir. Right after a CLI step exits, lingering grandchildren (speckit
// shell scripts, git subprocesses) and AV inline-scanning the just-written
// `.md` files routinely keep handles open for ~tens of ms. Same race the
// `rmWithRetry` helper in `tests/integration/pipeline-spec-setup-claudemd.test.ts`
// already documents for `rmSync`.
function isTransientMoveError(stderr: string): boolean {
	return (
		/Permission denied/i.test(stderr) ||
		/EBUSY|EACCES|EPERM/i.test(stderr) ||
		/being used by another process/i.test(stderr) ||
		/resource busy/i.test(stderr)
	);
}

const MOVE_WORKTREE_MAX_ATTEMPTS = 20;
const MOVE_WORKTREE_RETRY_DELAY_MS = 50;

export class WorkflowEngine {
	private workflow: Workflow | null = null;

	getWorkflow(): Workflow | null {
		return this.workflow;
	}

	setWorkflow(workflow: Workflow): void {
		this.workflow = workflow;
	}

	async createWorkflow(
		specification: string,
		targetRepository: string,
		managedRepo: Workflow["managedRepo"] = null,
		options: { workflowKind?: WorkflowKind } = {},
	): Promise<Workflow> {
		const workflowKind: WorkflowKind = options.workflowKind ?? "spec";
		if (workflowKind === "quick-fix" && specification.trim() === "") {
			throw new Error("Quick Fix description must not be empty.");
		}
		if (workflowKind === "ask-question") {
			const trimmed = specification.trim();
			if (trimmed === "") {
				throw new Error("Please enter a question.");
			}
			if (specification.length > ASK_QUESTION_MAX_LENGTH) {
				throw new Error(
					`Question is too long. The maximum allowed length is ${ASK_QUESTION_MAX_LENGTH.toLocaleString("en-US")} characters; this is a guardrail against the LLM token budget.`,
				);
			}
		}
		const id = randomUUID();
		const shortId = id.slice(0, 8);

		const now = new Date().toISOString();
		const stepDefs = getStepDefinitionsForKind(workflowKind);
		this.workflow = {
			id,
			workflowKind,
			specification,
			status: "idle",
			targetRepository,
			worktreePath: null,
			worktreeBranch: `tmp-${shortId}`,
			featureBranch: null,
			summary: "",
			stepSummary: "",
			flavor: "",
			pendingQuestion: null,
			lastOutput: "",
			steps: stepDefs.map((def) => ({
				name: def.name,
				displayName: def.displayName,
				status: "pending" as const,
				prompt: def.name === "specify" ? `${def.prompt} ${specification}` : def.prompt,
				sessionId: null,
				output: "",
				outputLog: [],
				error: null,
				startedAt: null,
				completedAt: null,
				pid: null,
				history: [],
			})),
			currentStepIndex: 0,
			prUrl: null,
			reviewCycle: {
				iteration: 1,
				maxIterations: configStore.get().limits.reviewCycleMaxIterations,
				lastSeverity: null,
			},
			ciCycle: {
				attempt: 0,
				maxAttempts: configStore.get().limits.ciFixMaxAttempts,
				monitorStartedAt: null,
				globalTimeoutMs: configStore.get().timing.ciGlobalTimeoutMs,
				lastCheckResults: [],
				failureLogs: [],
				userFixGuidance: null,
			},
			mergeCycle: {
				attempt: 0,
				maxAttempts: configStore.get().limits.mergeMaxAttempts,
			},
			epicId: null,
			epicTitle: null,
			epicDependencies: [],
			epicDependencyStatus: null,
			epicAnalysisMs: 0,
			activeWorkMs: 0,
			activeWorkStartedAt: null,
			feedbackEntries: [],
			feedbackPreRunHead: null,
			activeInvocation: null,
			managedRepo,
			error: null,
			hasEverStarted: false,
			createdAt: now,
			updatedAt: now,
			archived: false,
			archivedAt: null,
			aspectManifest: null,
			aspects: null,
			synthesizedAnswer: null,
		};

		return this.workflow;
	}

	transition(workflowId: string, newStatus: WorkflowStatus): void {
		const w = this.requireWorkflow(workflowId);
		const allowed = transitions[w.status];
		if (!allowed.includes(newStatus)) {
			throw new Error(`Invalid transition: ${w.status} → ${newStatus}`);
		}

		// Flip hasEverStarted on the first transition out of a not-yet-started state.
		if (
			!w.hasEverStarted &&
			(w.status === "idle" || w.status === "waiting_for_dependencies") &&
			newStatus !== "idle" &&
			newStatus !== "waiting_for_dependencies"
		) {
			w.hasEverStarted = true;
		}

		const now = new Date();

		// Accumulate timer when leaving "running"
		if (w.status === "running" && w.activeWorkStartedAt) {
			w.activeWorkMs += now.getTime() - new Date(w.activeWorkStartedAt).getTime();
			w.activeWorkStartedAt = null;
		}

		// Start timer when entering "running"
		if (newStatus === "running") {
			w.activeWorkStartedAt = now.toISOString();
		}

		if (
			newStatus === "idle" ||
			newStatus === "completed" ||
			newStatus === "aborted" ||
			newStatus === "error"
		) {
			w.activeInvocation = null;
		}

		w.status = newStatus;
		w.updatedAt = now.toISOString();
	}

	updateLastOutput(workflowId: string, text: string): void {
		const w = this.requireWorkflow(workflowId);
		w.lastOutput = text;
		w.updatedAt = new Date().toISOString();
	}

	updateSummary(workflowId: string, summary: string): void {
		const w = this.requireWorkflow(workflowId);
		w.summary = summary;
		w.updatedAt = new Date().toISOString();
	}

	updateStepSummary(workflowId: string, stepSummary: string): void {
		const w = this.requireWorkflow(workflowId);
		w.stepSummary = stepSummary;
		w.updatedAt = new Date().toISOString();
	}

	setQuestion(workflowId: string, question: Question): void {
		const w = this.requireWorkflow(workflowId);
		w.pendingQuestion = question;
		w.updatedAt = new Date().toISOString();
	}

	clearQuestion(workflowId: string): void {
		const w = this.requireWorkflow(workflowId);
		w.pendingQuestion = null;
		w.updatedAt = new Date().toISOString();
	}

	private requireWorkflow(workflowId: string): Workflow {
		if (!this.workflow || this.workflow.id !== workflowId) {
			throw new Error(`Workflow ${workflowId} not found`);
		}
		return this.workflow;
	}

	async removeWorktree(worktreePath: string, targetRepo: string): Promise<void> {
		const result = await gitSpawn(["git", "worktree", "remove", worktreePath, "--force"], {
			cwd: targetRepo,
			extra: { worktree: worktreePath },
		});
		if (result.code !== 0) {
			throw new Error(result.stderr || `git worktree remove failed with code ${result.code}`);
		}
	}

	async moveWorktree(
		oldPath: string,
		newRelativePath: string,
		targetRepo: string,
	): Promise<string> {
		let lastResult: { code: number; stderr: string } | null = null;
		for (let attempt = 0; attempt < MOVE_WORKTREE_MAX_ATTEMPTS; attempt++) {
			const result = await gitSpawn(["git", "worktree", "move", oldPath, newRelativePath], {
				cwd: targetRepo,
				extra: { from: oldPath, to: newRelativePath },
			});
			if (result.code === 0) return resolve(targetRepo, newRelativePath);
			lastResult = result;
			if (!isTransientMoveError(result.stderr)) break;
			await new Promise((r) => setTimeout(r, MOVE_WORKTREE_RETRY_DELAY_MS));
		}
		throw new Error(
			lastResult?.stderr || `git worktree move failed with code ${lastResult?.code ?? "?"}`,
		);
	}

	async createWorktree(shortId: string, cwd: string): Promise<string> {
		const worktreePath = `.worktrees/tmp-${shortId}`;
		const result = await gitSpawn(["git", "worktree", "add", "--detach", worktreePath], {
			cwd,
			extra: { target: worktreePath },
		});
		if (result.code === 0) {
			return resolve(cwd, worktreePath);
		}
		throw new Error(result.stderr || `git worktree add failed with code ${result.code}`);
	}

	private static readonly GITIGNORED_PATHS = [
		".serena",
		".specify",
		".claude",
		"specs",
		"CLAUDE.md",
	];

	async copyGitignoredFiles(sourceCwd: string, worktreePath: string): Promise<void> {
		for (const entry of WorkflowEngine.GITIGNORED_PATHS) {
			const src = join(sourceCwd, entry);
			const dest = join(worktreePath, entry);
			try {
				const s = await stat(src);
				await cp(src, dest, { recursive: s.isDirectory() });
			} catch {
				// Source doesn't exist — skip silently
			}
		}
	}
}

/**
 * Derive a lowercase-kebab slug from a quick-fix description.
 * Keeps ASCII letters/digits, collapses everything else to a single dash,
 * trims leading/trailing dashes, and caps the length at 40 characters.
 */
export function slugifyFixDescription(description: string): string {
	const slug = description
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/^-+|-+$/g, "");
	return slug || "fix";
}

/**
 * Compute the next available `fix/NNN-<slug>` branch name given the user's
 * description and the list of existing branch names in the repo. Sequence
 * numbers are allocated independently from speckit by scanning only branches
 * matching `fix/NNN-...`.
 */
export function nextFixBranchName(description: string, existingBranches: string[]): string {
	const slug = slugifyFixDescription(description);
	const used = new Set<number>();
	const pattern = /^fix\/(\d{3})-/;
	for (const raw of existingBranches) {
		const name = raw.replace(/^\*?\s*/, "").replace(/^(remotes\/[^/]+\/)/, "");
		const m = name.match(pattern);
		if (m) used.add(parseInt(m[1], 10));
	}
	let n = 1;
	while (used.has(n)) n++;
	const seq = String(n).padStart(3, "0");
	return `fix/${seq}-${slug}`;
}

/** Create multiple workflows from an epic decomposition result. */
export async function createEpicWorkflows(
	result: EpicAnalysisResult,
	targetRepository: string,
	epicId?: string,
	managedRepo: Workflow["managedRepo"] = null,
): Promise<{ workflows: Workflow[]; epicId: string }> {
	if (!epicId) epicId = randomUUID();
	const tempIdToWorkflowId = new Map<string, string>();
	const workflows: Workflow[] = [];

	// Single-spec fallback — create one normal workflow
	if (result.specs.length === 1) {
		const spec = result.specs[0];
		const engine = new WorkflowEngine();
		const workflow = await engine.createWorkflow(spec.description, targetRepository, managedRepo);
		workflow.epicId = epicId;
		workflow.epicTitle = result.title;
		workflow.epicDependencies = [];
		workflow.epicDependencyStatus = "satisfied";
		workflow.summary = spec.title;
		workflows.push(workflow);
		return { workflows, epicId };
	}

	// First pass: create all workflows to get real IDs
	for (const spec of result.specs) {
		const engine = new WorkflowEngine();
		const workflow = await engine.createWorkflow(spec.description, targetRepository, managedRepo);
		workflow.epicId = epicId;
		workflow.epicTitle = result.title;
		workflow.summary = spec.title;
		tempIdToWorkflowId.set(spec.id, workflow.id);
		workflows.push(workflow);
	}

	// Second pass: map temp dependency IDs to real workflow IDs
	for (let i = 0; i < result.specs.length; i++) {
		const spec = result.specs[i];
		const workflow = workflows[i];
		workflow.epicDependencies = spec.dependencies
			.map((tempId) => tempIdToWorkflowId.get(tempId))
			.filter((id): id is string => id !== undefined);
	}

	// Transitive reduction: remove edges implied by longer paths
	const depsMap = new Map<string, string[]>();
	for (const wf of workflows) {
		depsMap.set(wf.id, wf.epicDependencies);
	}

	function isReachable(from: string, target: string, visited: Set<string>): boolean {
		if (from === target) return true;
		if (visited.has(from)) return false;
		visited.add(from);
		for (const dep of depsMap.get(from) ?? []) {
			if (isReachable(dep, target, visited)) return true;
		}
		return false;
	}

	for (const wf of workflows) {
		if (wf.epicDependencies.length < 2) continue;
		const reduced: string[] = [];
		for (const dep of wf.epicDependencies) {
			// Keep dep only if it's NOT reachable through any other direct dependency
			const redundant = wf.epicDependencies.some(
				(other) => other !== dep && isReachable(other, dep, new Set()),
			);
			if (!redundant) reduced.push(dep);
		}
		wf.epicDependencies = reduced;
	}

	// Set dependency status
	for (const wf of workflows) {
		if (wf.epicDependencies.length > 0) {
			wf.epicDependencyStatus = "waiting";
			wf.status = "waiting_for_dependencies";
		} else {
			wf.epicDependencyStatus = "satisfied";
		}
	}

	return { workflows, epicId };
}

/**
 * Reset a workflow in `error` or `aborted` state back to Setup (step 0,
 * `idle`). Deletes the managed worktree, branch, and artifact files in
 * order; "already missing" at any target counts as success (FR-008). On
 * partial failure the workflow transitions to `error` with a message
 * naming exactly the targets that could not be removed (FR-009), so a
 * subsequent retry can converge. Preserves `id` and `epicId` (FR-006).
 *
 * Module-level pure mutation on the provided workflow record; callers that
 * loaded the workflow directly from `WorkflowStore` (e.g. a previously-
 * aborted workflow with no live orchestrator) can use it directly.
 */
export async function resetWorkflow(workflow: Workflow): Promise<ResetOutcome> {
	const outcome: ResetOutcome = {
		branch: { ok: true },
		worktree: { ok: true },
		artifacts: { ok: true, removed: 0 },
		partialFailure: false,
	};

	const worktreePath = workflow.worktreePath;
	if (worktreePath) {
		try {
			const targetRepo = workflow.targetRepository;
			if (!targetRepo) {
				outcome.worktree = {
					ok: false,
					error: "no targetRepository",
					path: worktreePath,
				};
			} else {
				const result = await gitSpawn(["git", "worktree", "remove", worktreePath, "--force"], {
					cwd: targetRepo,
					extra: { worktree: worktreePath },
				});
				if (result.code !== 0 && !isWorktreeMissing(result.stderr)) {
					outcome.worktree = {
						ok: false,
						error: result.stderr || `exit ${result.code}`,
						path: worktreePath,
					};
				}
			}
		} catch (err) {
			outcome.worktree = {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
				path: worktreePath,
			};
		}
	}

	const branchName = workflow.worktreeBranch;
	if (branchName && workflow.targetRepository) {
		try {
			const result = await gitSpawn(["git", "branch", "-D", branchName], {
				cwd: workflow.targetRepository,
				extra: { branch: branchName },
			});
			if (result.code !== 0 && !isBranchMissing(result.stderr)) {
				outcome.branch = {
					ok: false,
					error: result.stderr || `exit ${result.code}`,
					name: branchName,
				};
			}
		} catch (err) {
			outcome.branch = {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
				name: branchName,
			};
		}
	}

	const artifactsResult = clearArtifacts(workflow.id);
	if (artifactsResult.failed.length > 0) {
		outcome.artifacts = {
			ok: false,
			removed: artifactsResult.removed,
			failed: artifactsResult.failed,
		};
	} else {
		outcome.artifacts = { ok: true, removed: artifactsResult.removed };
	}

	outcome.partialFailure = !outcome.branch.ok || !outcome.worktree.ok || !outcome.artifacts.ok;

	const now = new Date().toISOString();
	if (outcome.worktree.ok) workflow.worktreePath = null;
	workflow.currentStepIndex = 0;
	workflow.featureBranch = null;
	workflow.pendingQuestion = null;
	workflow.prUrl = null;
	workflow.lastOutput = "";
	workflow.activeInvocation = null;
	workflow.activeWorkStartedAt = null;
	workflow.feedbackPreRunHead = null;
	workflow.summary = "";
	workflow.stepSummary = "";
	workflow.flavor = "";
	workflow.feedbackEntries = [];
	workflow.epicAnalysisMs = 0;
	workflow.activeWorkMs = 0;
	if (workflow.epicDependencyStatus === "overridden") {
		workflow.epicDependencyStatus = workflow.epicDependencies.length > 0 ? "waiting" : "satisfied";
	}
	workflow.ciCycle.attempt = 0;
	workflow.ciCycle.monitorStartedAt = null;
	workflow.ciCycle.lastCheckResults = [];
	workflow.ciCycle.failureLogs = [];
	workflow.ciCycle.userFixGuidance = null;
	workflow.mergeCycle.attempt = 0;
	workflow.reviewCycle.iteration = 1;
	workflow.reviewCycle.lastSeverity = null;
	workflow.aspectManifest = null;
	workflow.aspects = null;
	workflow.synthesizedAnswer = null;

	for (let i = 0; i < workflow.steps.length; i++) {
		const step = workflow.steps[i];
		// Look up by name — `workflow.steps` follows the kind-specific ordering
		// (`SPEC_ORDER` / `QUICK_FIX_ORDER` / `ASK_QUESTION_ORDER`), so positional
		// indexing into `PIPELINE_STEP_DEFINITIONS` (spec-pipeline order) would
		// assign the wrong prompt for non-spec kinds.
		const def = getStepDefinitionByName(step.name);
		step.status = "pending";
		step.output = "";
		step.outputLog = [];
		step.error = null;
		step.startedAt = null;
		step.completedAt = null;
		step.pid = null;
		step.sessionId = null;
		step.history = [];
		if (def) {
			step.prompt = def.name === "specify" ? `${def.prompt} ${workflow.specification}` : def.prompt;
		}
	}

	if (outcome.partialFailure) {
		workflow.status = "error";
		const parts: string[] = [];
		if (!outcome.branch.ok) parts.push(`branch ${outcome.branch.name}`);
		if (!outcome.worktree.ok) parts.push(`worktree ${outcome.worktree.path}`);
		if (!outcome.artifacts.ok) {
			const n = outcome.artifacts.failed.length;
			parts.push(`${n} artifact file(s)`);
		}
		const message = `Reset failed: could not delete ${parts.join(", ")}`;
		workflow.error = { message };
	} else {
		workflow.status = "idle";
		workflow.error = null;
		// Regenerate the managed branch name from the stable id.
		// `createWorkflow` uses the exact same formula, so this is idempotent
		// for any workflow created through the normal path: the branch name
		// returns to its original value rather than being silently rewritten.
		workflow.worktreeBranch = `tmp-${workflow.id.slice(0, 8)}`;
	}

	workflow.updatedAt = now;
	return outcome;
}
