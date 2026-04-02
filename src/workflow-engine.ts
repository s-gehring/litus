import type { Workflow, WorkflowStatus, Question } from "./types";
import { VALID_TRANSITIONS as transitions } from "./types";
import { randomUUID } from "crypto";
import { resolve } from "path";

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
        `Failed to create git worktree: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const now = new Date().toISOString();
    this.workflow = {
      id,
      specification,
      status: "idle",
      sessionId: null,
      worktreePath,
      worktreeBranch: branchName,
      summary: "",
      pendingQuestion: null,
      lastOutput: "",
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

  setSessionId(workflowId: string, sessionId: string): void {
    const w = this.requireWorkflow(workflowId);
    w.sessionId = sessionId;
    w.updatedAt = new Date().toISOString();
  }

  private requireWorkflow(workflowId: string): Workflow {
    if (!this.workflow || this.workflow.id !== workflowId) {
      throw new Error(`Workflow ${workflowId} not found`);
    }
    return this.workflow;
  }

  async removeWorktree(workflowId: string): Promise<void> {
    const w = this.workflow;
    if (!w || w.id !== workflowId || !w.worktreePath) return;

    try {
      const proc = Bun.spawn(["git", "worktree", "remove", w.worktreePath, "--force"], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
    } catch {
      // Best-effort cleanup
    }
  }

  private createWorktree(branchName: string): Promise<string> {
    return new Promise((res, reject) => {
      const worktreePath = `.worktrees/${branchName.replaceAll("/", "-")}`;
      const proc = Bun.spawn(["git", "worktree", "add", worktreePath, "-b", branchName], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });

      proc.exited.then((code) => {
        if (code === 0) {
          const absPath = resolve(process.cwd(), worktreePath);
          res(absPath);
        } else {
          const stderrStream = proc.stderr;
          const stderrPromise = stderrStream && typeof stderrStream !== "number"
            ? new Response(stderrStream as ReadableStream).text()
            : Promise.resolve("");
          stderrPromise.then((stderr) => {
            reject(new Error(stderr.trim() || `git worktree add failed with code ${code}`));
          });
        }
      });
    });
  }
}
