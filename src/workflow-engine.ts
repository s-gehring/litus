import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Question, Workflow, WorkflowStatus } from "./types";
import {
	PIPELINE_STEP_DEFINITIONS,
	REVIEW_CYCLE_MAX_ITERATIONS,
	VALID_TRANSITIONS as transitions,
} from "./types";

export class WorkflowEngine {
	private workflow: Workflow | null = null;

	getWorkflow(): Workflow | null {
		return this.workflow;
	}

	async createWorkflow(specification: string): Promise<Workflow> {
		const id = randomUUID();
		const branchName = `crab-studio/${id.slice(0, 8)}`;
		let worktreePath: string | null = null;

		// Create git worktree
		try {
			worktreePath = await this.createWorktree(branchName);
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
			worktreePath,
			worktreeBranch: branchName,
			summary: "",
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
			})),
			currentStepIndex: 0,
			reviewCycle: {
				iteration: 1,
				maxIterations: REVIEW_CYCLE_MAX_ITERATIONS,
				lastSeverity: null,
			},
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
		w.status = newStatus;
		w.updatedAt = new Date().toISOString();
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

	private async createWorktree(branchName: string): Promise<string> {
		const worktreePath = `.worktrees/${branchName.replaceAll("/", "-")}`;
		const proc = Bun.spawn(["git", "worktree", "add", worktreePath, "-b", branchName], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		});

		const code = await proc.exited;
		if (code === 0) {
			return resolve(process.cwd(), worktreePath);
		}

		const stderrStream = proc.stderr;
		const stderr =
			stderrStream && typeof stderrStream !== "number"
				? await new Response(stderrStream as ReadableStream).text()
				: "";
		throw new Error(stderr.trim() || `git worktree add failed with code ${code}`);
	}
}
