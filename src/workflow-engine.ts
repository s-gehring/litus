import { randomUUID } from "node:crypto";
import { cp, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configStore } from "./config-store";
import { gitSpawn } from "./git-logger";
import type { EpicAnalysisResult, Question, Workflow, WorkflowStatus } from "./types";
import { PIPELINE_STEP_DEFINITIONS, VALID_TRANSITIONS as transitions } from "./types";

export class WorkflowEngine {
	private workflow: Workflow | null = null;

	getWorkflow(): Workflow | null {
		return this.workflow;
	}

	setWorkflow(workflow: Workflow): void {
		this.workflow = workflow;
	}

	async createWorkflow(specification: string, targetRepository: string): Promise<Workflow> {
		const id = randomUUID();
		const shortId = id.slice(0, 8);

		const now = new Date().toISOString();
		this.workflow = {
			id,
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
			steps: PIPELINE_STEP_DEFINITIONS.map((def) => ({
				name: def.name,
				displayName: def.displayName,
				status: "pending" as const,
				prompt: def.name === "specify" ? `${def.prompt} ${specification}` : def.prompt,
				sessionId: null,
				output: "",
				error: null,
				startedAt: null,
				completedAt: null,
				pid: null,
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
			createdAt: now,
			updatedAt: now,
		};

		return this.workflow;
	}

	transition(workflowId: string, newStatus: WorkflowStatus): void {
		const w = this.requireWorkflow(workflowId);
		const allowed = transitions[w.status];
		if (!allowed.includes(newStatus)) {
			throw new Error(`Invalid transition: ${w.status} → ${newStatus}`);
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
		const result = await gitSpawn(["git", "worktree", "move", oldPath, newRelativePath], {
			cwd: targetRepo,
			extra: { from: oldPath, to: newRelativePath },
		});
		if (result.code !== 0) {
			throw new Error(result.stderr || `git worktree move failed with code ${result.code}`);
		}
		return resolve(targetRepo, newRelativePath);
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

/** Create multiple workflows from an epic decomposition result. */
export async function createEpicWorkflows(
	result: EpicAnalysisResult,
	targetRepository: string,
	epicId?: string,
): Promise<{ workflows: Workflow[]; epicId: string }> {
	if (!epicId) epicId = randomUUID();
	const tempIdToWorkflowId = new Map<string, string>();
	const workflows: Workflow[] = [];

	// Single-spec fallback — create one normal workflow
	if (result.specs.length === 1) {
		const spec = result.specs[0];
		const engine = new WorkflowEngine();
		const workflow = await engine.createWorkflow(spec.description, targetRepository);
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
		const workflow = await engine.createWorkflow(spec.description, targetRepository);
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
