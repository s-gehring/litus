import { randomUUID } from "node:crypto";
import { cp, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configStore } from "./config-store";
import type { Question, Workflow, WorkflowStatus } from "./types";
import { PIPELINE_STEP_DEFINITIONS, VALID_TRANSITIONS as transitions } from "./types";

export class WorkflowEngine {
	private workflow: Workflow | null = null;

	getWorkflow(): Workflow | null {
		return this.workflow;
	}

	setWorkflow(workflow: Workflow): void {
		this.workflow = workflow;
	}

	async createWorkflow(specification: string, targetRepository?: string | null): Promise<Workflow> {
		const id = randomUUID();
		const branchName = `crab-studio/${id.slice(0, 8)}`;
		let worktreePath: string | null = null;
		const effectiveRepo = targetRepository || null;
		const baseCwd = targetRepository || process.cwd();

		// Create git worktree and copy gitignored files
		try {
			worktreePath = await this.createWorktree(branchName, baseCwd);
			await this.copyGitignoredFiles(baseCwd, worktreePath);
		} catch (err) {
			throw new Error(
				`Failed to create git worktree: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const now = new Date().toISOString();
		this.workflow = {
			id,
			specification,
			status: "idle",
			targetRepository: effectiveRepo,
			worktreePath,
			worktreeBranch: branchName,
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
		const proc = Bun.spawn(["git", "worktree", "remove", worktreePath, "--force"], {
			cwd: targetRepo,
			stdout: "pipe",
			stderr: "pipe",
		});

		const code = await proc.exited;
		if (code !== 0) {
			const stderrStream = proc.stderr;
			const stderr =
				stderrStream && typeof stderrStream !== "number"
					? await new Response(stderrStream as ReadableStream).text()
					: "";
			throw new Error(stderr.trim() || `git worktree remove failed with code ${code}`);
		}
	}

	private async createWorktree(branchName: string, cwd: string): Promise<string> {
		const worktreePath = `.worktrees/${branchName.replaceAll("/", "-")}`;
		const proc = Bun.spawn(["git", "worktree", "add", worktreePath, "-b", branchName], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});

		const code = await proc.exited;
		if (code === 0) {
			return resolve(cwd, worktreePath);
		}

		const stderrStream = proc.stderr;
		const stderr =
			stderrStream && typeof stderrStream !== "number"
				? await new Response(stderrStream as ReadableStream).text()
				: "";
		throw new Error(stderr.trim() || `git worktree add failed with code ${code}`);
	}

	private static readonly GITIGNORED_PATHS = [
		".serena",
		".specify",
		".claude",
		"specs",
		"CLAUDE.md",
	];

	private async copyGitignoredFiles(sourceCwd: string, worktreePath: string): Promise<void> {
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
