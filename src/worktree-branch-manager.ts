import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type ClaudeMdGuardResult, guardClaudeMd as defaultGuardClaudeMd } from "./claude-md-guard";
import {
	type AppendResult,
	appendProjectClaudeMd as defaultAppendProjectClaudeMd,
	markClaudeMdSkipWorktree as defaultMarkClaudeMdSkipWorktree,
	type SkipWorktreeResult,
} from "./claude-md-merger";
import { toErrorMessage } from "./errors";
import { detectNewCommits as defaultDetectNewCommits } from "./feedback-implementer";
import { gitSpawn } from "./git-logger";
import { logger } from "./logger";
import { ensureSpeckitSkills as defaultEnsureSpeckitSkills } from "./setup-checker";
import type { Workflow } from "./types";
import { nextFixBranchName, type WorkflowEngine } from "./workflow-engine";
import { requireTargetRepository, requireWorktreePath } from "./workflow-paths";

export type WorktreeOpResult<T = void> =
	| { ok: true; data: T; messages: string[] }
	| { ok: false; error: string; messages: string[] }
	| { aborted: true; messages: string[] };

const ABORTED = (messages: string[]): WorktreeOpResult<never> => ({ aborted: true, messages });

export interface WorktreeBranchManagerDeps {
	appendProjectClaudeMd?: (specWorktree: string) => Promise<AppendResult>;
	ensureSpeckitSkills?: typeof defaultEnsureSpeckitSkills;
	markClaudeMdSkipWorktree?: (specWorktree: string) => Promise<SkipWorktreeResult>;
	checkoutMaster?: (cwd: string) => Promise<{ code: number; stderr: string }>;
	getGitHead?: (cwd: string) => Promise<string | null>;
	detectNewCommits?: (preRunHead: string, cwd: string) => Promise<string[]>;
	guardClaudeMd?: (cwd: string) => Promise<ClaudeMdGuardResult>;
}

export class WorktreeBranchManager {
	private readonly engine: WorkflowEngine;
	private readonly appendProjectClaudeMdFn: (specWorktree: string) => Promise<AppendResult>;
	private readonly ensureSpeckitSkillsFn: typeof defaultEnsureSpeckitSkills;
	private readonly markClaudeMdSkipWorktreeFn: (
		specWorktree: string,
	) => Promise<SkipWorktreeResult>;
	private readonly checkoutMasterFn: (cwd: string) => Promise<{ code: number; stderr: string }>;
	private readonly getGitHeadFn: (cwd: string) => Promise<string | null>;
	private readonly detectNewCommitsFn: (preRunHead: string, cwd: string) => Promise<string[]>;
	private readonly guardClaudeMdFn: (cwd: string) => Promise<ClaudeMdGuardResult>;

	constructor(engine: WorkflowEngine, deps?: WorktreeBranchManagerDeps) {
		this.engine = engine;
		this.appendProjectClaudeMdFn = deps?.appendProjectClaudeMd ?? defaultAppendProjectClaudeMd;
		this.ensureSpeckitSkillsFn = deps?.ensureSpeckitSkills ?? defaultEnsureSpeckitSkills;
		this.markClaudeMdSkipWorktreeFn =
			deps?.markClaudeMdSkipWorktree ?? defaultMarkClaudeMdSkipWorktree;
		this.checkoutMasterFn =
			deps?.checkoutMaster ??
			(async (cwd: string) => {
				await gitSpawn(["git", "fetch", "origin", "master"], { cwd });
				const result = await gitSpawn(["git", "checkout", "--detach", "origin/master"], {
					cwd,
				});
				return { code: result.code, stderr: result.stderr };
			});
		this.getGitHeadFn =
			deps?.getGitHead ??
			(async (cwd: string) => {
				try {
					const r = await gitSpawn(["git", "rev-parse", "HEAD"], { cwd });
					return r.code === 0 ? r.stdout.trim() : null;
				} catch {
					return null;
				}
			});
		this.detectNewCommitsFn = deps?.detectNewCommits ?? defaultDetectNewCommits;
		this.guardClaudeMdFn = deps?.guardClaudeMd ?? defaultGuardClaudeMd;
	}

	async createWorktreeAndCheckout(
		workflow: Workflow,
		isLive: () => boolean = () => true,
	): Promise<WorktreeOpResult<{ worktreePath: string }>> {
		const targetDir = requireTargetRepository(workflow);
		const shortId = workflow.worktreeBranch.replace("tmp-", "");

		let worktreePath: string;
		try {
			worktreePath = await this.engine.createWorktree(shortId, targetDir);
		} catch (err) {
			return {
				ok: false,
				error: `Failed to create git worktree: ${toErrorMessage(err)}`,
				messages: [],
			};
		}
		if (!isLive()) return ABORTED([]);

		workflow.worktreePath = worktreePath;
		try {
			await this.engine.copyGitignoredFiles(targetDir, worktreePath);
		} catch (copyErr) {
			try {
				await this.engine.removeWorktree(worktreePath, targetDir);
			} catch {
				// Best-effort cleanup
			}
			workflow.worktreePath = null;
			return {
				ok: false,
				error: `Failed to create git worktree: ${toErrorMessage(copyErr)}`,
				messages: [],
			};
		}
		if (!isLive()) return ABORTED([]);

		return { ok: true, data: { worktreePath }, messages: [] };
	}

	async checkoutMasterInWorktree(
		workflow: Workflow,
		isLive: () => boolean = () => true,
	): Promise<WorktreeOpResult> {
		const cwd = requireWorktreePath(workflow);
		const messages: string[] = ["[git] fetch + checkout --detach origin/master | cwd=worktree"];
		try {
			const result = await this.checkoutMasterFn(cwd);
			if (!isLive()) return ABORTED(messages);
			if (result.code !== 0) {
				const errMsg = result.stderr || `exit code ${result.code}`;
				return {
					ok: false,
					error: `Failed to checkout master in worktree: ${errMsg}`,
					messages,
				};
			}
			messages.push("✓ Checked out latest master in worktree");
			return { ok: true, data: undefined, messages };
		} catch (err) {
			return {
				ok: false,
				error: `Failed to checkout master in worktree: ${toErrorMessage(err)}`,
				messages,
			};
		}
	}

	async initSpeckitInWorktree(
		workflow: Workflow,
		isLive: () => boolean = () => true,
	): Promise<WorktreeOpResult<{ kind: "spec-ready" | "skipped-quickfix" }>> {
		if (workflow.workflowKind === "quick-fix") {
			return { ok: true, data: { kind: "skipped-quickfix" }, messages: [] };
		}
		const cwd = requireWorktreePath(workflow);
		const messages: string[] = ["[speckit] Ensuring spec-kit skills in worktree"];

		try {
			const { installed, initResult } = await this.ensureSpeckitSkillsFn(cwd);
			if (!isLive()) return ABORTED(messages);
			if (!installed) {
				const errMsg = initResult?.stderr || `exit code ${initResult?.code}`;
				return {
					ok: false,
					error: `Failed to initialize spec-kit: ${errMsg}`,
					messages,
				};
			}
			messages.push(
				initResult ? "✓ Spec-kit initialized via uvx" : "✓ Spec-kit skills already present",
			);

			if (workflow.workflowKind === "spec") {
				const append = await this.appendProjectClaudeMdFn(cwd);
				if (!isLive()) return ABORTED(messages);
				switch (append.outcome) {
					case "appended":
						messages.push("✓ Appended project CLAUDE.md");
						break;
					case "skipped":
						messages.push("✓ Project CLAUDE.md already appended");
						break;
					case "no-project":
						messages.push("• No project CLAUDE.md in main worktree — skipping append");
						break;
					case "no-main":
						logger.warn("[pipeline] Could not resolve main worktree; skipping CLAUDE.md append");
						messages.push("• Could not resolve main worktree — skipping project CLAUDE.md append");
						break;
				}

				const skip = await this.markClaudeMdSkipWorktreeFn(cwd);
				if (!isLive()) return ABORTED(messages);
				if (skip.outcome === "marked") {
					messages.push("✓ CLAUDE.md marked skip-worktree");
				} else {
					messages.push("• CLAUDE.md not tracked in index — skip-worktree not applicable");
				}
			}

			return { ok: true, data: { kind: "spec-ready" }, messages };
		} catch (err) {
			return {
				ok: false,
				error: `Failed to initialize spec-kit: ${toErrorMessage(err)}`,
				messages,
			};
		}
	}

	async initQuickFixBranch(
		workflow: Workflow,
		isLive: () => boolean = () => true,
	): Promise<WorktreeOpResult<{ branchName: string; worktreePath: string | null }>> {
		const messages: string[] = ["[quick-fix] Allocating fix branch name"];
		try {
			const cwd = requireWorktreePath(workflow);
			const targetRepo = requireTargetRepository(workflow);

			const branchList = await gitSpawn(["git", "branch", "-a"], { cwd });
			if (!isLive()) return ABORTED(messages);
			const existing = branchList.code === 0 ? branchList.stdout.split(/\r?\n/) : [];
			const branchName = nextFixBranchName(workflow.specification, existing);

			const checkout = await gitSpawn(["git", "checkout", "-b", branchName], { cwd });
			if (!isLive()) return ABORTED(messages);
			if (checkout.code !== 0) {
				return {
					ok: false,
					error: `Failed to create fix branch ${branchName}: ${checkout.stderr || checkout.code}`,
					messages,
				};
			}
			messages.push(`✓ Created fix branch ${branchName}`);

			workflow.featureBranch = branchName;
			workflow.worktreeBranch = branchName;

			let newWorktreePath: string | null = null;
			if (workflow.worktreePath) {
				const newRelativePath = `.worktrees/${branchName.replace(/\//g, "-")}`;
				try {
					const newAbsPath = await this.engine.moveWorktree(
						workflow.worktreePath,
						newRelativePath,
						targetRepo,
					);
					if (!isLive()) return ABORTED(messages);
					workflow.worktreePath = newAbsPath;
					newWorktreePath = newAbsPath;
				} catch (err) {
					logger.warn(
						`[pipeline] Quick-fix worktree rename failed (non-fatal): ${toErrorMessage(err)}`,
					);
				}
			}

			return {
				ok: true,
				data: { branchName, worktreePath: newWorktreePath },
				messages,
			};
		} catch (err) {
			return {
				ok: false,
				error: `Failed to initialize quick-fix branch: ${toErrorMessage(err)}`,
				messages,
			};
		}
	}

	async ensureBranchBeforeCommitPushPr(workflow: Workflow, cwd: string): Promise<WorktreeOpResult> {
		const messages: string[] = [];
		let branch: string | null = null;
		try {
			const result = await gitSpawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
			branch = result.code === 0 && result.stdout ? result.stdout : null;
		} catch {
			branch = null;
		}
		if (branch !== "HEAD") return { ok: true, data: undefined, messages };

		const targetBranch = workflow.featureBranch ?? workflow.worktreeBranch;
		if (!targetBranch) {
			return {
				ok: false,
				error: "Worktree is on detached HEAD and no feature branch name is available to recover",
				messages,
			};
		}

		const warnMsg = `[safety] Worktree on detached HEAD — switching to branch '${targetBranch}' before creating PR`;
		logger.warn(`[pipeline] ${warnMsg}`);
		messages.push(warnMsg);

		const switchExisting = await gitSpawn(["git", "switch", targetBranch], { cwd });
		if (switchExisting.code === 0) {
			const okMsg = `[safety] Switched to existing branch '${targetBranch}'`;
			logger.info(`[pipeline] ${okMsg}`);
			messages.push(okMsg);
			return { ok: true, data: undefined, messages };
		}

		const createBranch = await gitSpawn(["git", "switch", "-c", targetBranch], { cwd });
		if (createBranch.code === 0) {
			const okMsg = `[safety] Created branch '${targetBranch}' from detached HEAD`;
			logger.info(`[pipeline] ${okMsg}`);
			messages.push(okMsg);
			return { ok: true, data: undefined, messages };
		}

		return {
			ok: false,
			error: `Failed to recover from detached HEAD: could not switch to or create branch '${targetBranch}': ${createBranch.stderr || `exit ${createBranch.code}`}`,
			messages,
		};
	}

	async restoreClaudeMdBeforePush(workflow: Workflow): Promise<{
		outcome: "unchanged" | "restored" | "no-merge-base";
		commitSha: string | null;
		messages: string[];
	}> {
		const cwd = requireWorktreePath(workflow);
		const guardResult = await this.guardClaudeMdFn(cwd);
		if (guardResult.outcome === "unchanged") {
			return {
				outcome: "unchanged",
				commitSha: null,
				messages: ["✓ CLAUDE.md unchanged vs merge-base — no restore needed"],
			};
		}
		if (guardResult.outcome === "restored") {
			return {
				outcome: "restored",
				commitSha: guardResult.commitSha,
				messages: [
					`✓ Restored CLAUDE.md (${guardResult.action}) in ${guardResult.commitSha.slice(0, 7)}`,
				],
			};
		}
		const warnMsg = "⚠ No merge-base with origin/master — skipping CLAUDE.md restore";
		logger.warn(`[claude-md-guard] ${warnMsg} (workflow=${workflow.id})`);
		return { outcome: "no-merge-base", commitSha: null, messages: [warnMsg] };
	}

	async renameWorktreeToFeatureBranch(workflow: Workflow): Promise<{ renamed: boolean }> {
		const worktreePath = workflow.worktreePath as string;
		const targetRepo = workflow.targetRepository as string;
		const newRelativePath = `.worktrees/${workflow.featureBranch}`;
		try {
			const newAbsPath = await this.engine.moveWorktree(worktreePath, newRelativePath, targetRepo);
			workflow.worktreePath = newAbsPath;
			workflow.worktreeBranch = workflow.featureBranch as string;
			logger.info(`[pipeline] Renamed worktree to ${newRelativePath}`);
			return { renamed: true };
		} catch (err) {
			logger.warn(`[pipeline] Worktree rename failed (non-fatal): ${toErrorMessage(err)}`);
			return { renamed: false };
		}
	}

	detectFeatureBranch(workflow: Workflow): { detected: string | null } {
		const specsDir = join(workflow.worktreePath as string, "specs");
		try {
			const entries = readdirSync(specsDir, { withFileTypes: true });
			let best: string | null = null;
			let bestNum = -1;
			let bestTs = "";
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const seqMatch = entry.name.match(/^(\d{3,})-/);
				const tsMatch = entry.name.match(/^(\d{8}-\d{6})-/);
				if (tsMatch) {
					if (tsMatch[1] > bestTs) {
						bestTs = tsMatch[1];
						best = entry.name;
					}
				} else if (seqMatch) {
					const num = Number.parseInt(seqMatch[1], 10);
					if (num > bestNum) {
						bestNum = num;
						if (!bestTs) best = entry.name;
					}
				}
			}
			if (best) {
				logger.info(`[pipeline] Detected feature branch: ${best}`);
				return { detected: best };
			}
			return { detected: null };
		} catch (err) {
			logger.warn("[pipeline] Failed to scan specs/ directory:", err);
			return { detected: null };
		}
	}

	shouldRenameWorktree(workflow: Workflow): boolean {
		if (!workflow.featureBranch || !workflow.worktreePath || !workflow.targetRepository)
			return false;
		const dirName = workflow.worktreePath.split(/[/\\]/).pop() ?? "";
		return dirName.startsWith("tmp-");
	}

	getGitHead(cwd: string): Promise<string | null> {
		return this.getGitHeadFn(cwd);
	}

	async getBranch(cwd: string): Promise<string | null> {
		try {
			const r = await gitSpawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
			return r.code === 0 && r.stdout ? r.stdout : null;
		} catch {
			return null;
		}
	}

	detectNewCommits(preRunHead: string, cwd: string): Promise<string[]> {
		return this.detectNewCommitsFn(preRunHead, cwd);
	}
}
