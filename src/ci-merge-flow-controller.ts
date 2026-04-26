import { buildFixPrompt, gatherAllFailureLogs } from "./ci-fixer";
import { allFailuresCancelled, type MonitorResult } from "./ci-monitor";
import type { CIMonitorCoordinator } from "./ci-monitor-coordinator";
import { configStore } from "./config-store";
import { toErrorMessage } from "./errors";
import { gitSpawn } from "./git-logger";
import {
	mergePr as defaultMergePr,
	resolveConflicts as defaultResolveConflicts,
} from "./pr-merger";
import { syncRepo as defaultSyncRepo } from "./repo-syncer";
import type { CiFailureLog, EffortLevel, MergeResult, Question, Workflow } from "./types";
import type { WorkflowEngine } from "./workflow-engine";

export type CiFlowOutcome =
	| { kind: "advance" }
	| { kind: "advanceToFixCi" }
	| { kind: "routeBackToMonitor"; incrementMergeAttempt: boolean }
	| { kind: "routeToMergePrPause" }
	| { kind: "retryMergeAfterAlreadyUpToDate" }
	| { kind: "pauseForQuestion"; question: Question }
	| {
			kind: "runCliStep";
			prompt: string;
			model: string | undefined;
			effort: EffortLevel | undefined;
			failureLogs: CiFailureLog[];
			clearUserFixGuidance: boolean;
	  }
	| { kind: "error"; message: string }
	| { kind: "done" };

export interface CiMergeFlowControllerOptions {
	ciMonitor: CIMonitorCoordinator;
	mergePr: typeof defaultMergePr;
	resolveConflicts: typeof defaultResolveConflicts;
	syncRepo: typeof defaultSyncRepo;
	discoverPrUrl: (workflow: Workflow) => Promise<string | null>;
	stepOutput: (workflowId: string, msg: string) => void;
	engine: WorkflowEngine;
}

function requireWorktreePath(workflow: Workflow): string {
	if (!workflow.worktreePath) {
		throw new Error(
			`Workflow ${workflow.id} has no worktreePath — cannot determine working directory`,
		);
	}
	return workflow.worktreePath;
}

function requireTargetRepository(workflow: Workflow): string {
	if (!workflow.targetRepository) {
		throw new Error(
			`Workflow ${workflow.id} has no targetRepository — cannot determine target directory`,
		);
	}
	return workflow.targetRepository;
}

export class CiMergeFlowController {
	private readonly ciMonitor: CIMonitorCoordinator;
	private readonly mergePrFn: typeof defaultMergePr;
	private readonly resolveConflictsFn: typeof defaultResolveConflicts;
	private readonly syncRepoFn: typeof defaultSyncRepo;
	private readonly discoverPrUrlFn: (workflow: Workflow) => Promise<string | null>;
	private readonly stepOutput: (workflowId: string, msg: string) => void;
	private readonly engine: WorkflowEngine;

	constructor(options: CiMergeFlowControllerOptions) {
		this.ciMonitor = options.ciMonitor;
		this.mergePrFn = options.mergePr;
		this.resolveConflictsFn = options.resolveConflicts;
		this.syncRepoFn = options.syncRepo;
		this.discoverPrUrlFn = options.discoverPrUrl;
		this.stepOutput = options.stepOutput;
		this.engine = options.engine;
	}

	advanceToFixCi(): CiFlowOutcome {
		return { kind: "advanceToFixCi" };
	}

	routeToMergePrPause(): CiFlowOutcome {
		return { kind: "routeToMergePrPause" };
	}

	routeBackToMonitor(): CiFlowOutcome {
		return { kind: "routeBackToMonitor", incrementMergeAttempt: false };
	}

	async discoverPrUrl(workflow: Workflow): Promise<string | null> {
		const cwd = workflow.worktreePath ?? workflow.targetRepository;
		if (!cwd) return null;

		const branch = workflow.featureBranch ?? workflow.worktreeBranch;
		const result = await gitSpawn(
			["gh", "pr", "list", "--head", branch, "--json", "url", "--limit", "1"],
			{ cwd, extra: { branch } },
		);
		if (result.code !== 0) return null;

		try {
			const parsed = JSON.parse(result.stdout);
			if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].url) {
				return parsed[0].url;
			}
		} catch {
			// ignore parse errors
		}
		return null;
	}

	handleMonitorResult(workflow: Workflow, result: MonitorResult): CiFlowOutcome {
		if (result.passed) {
			return { kind: "advance" };
		}

		// Read the freshest limit from configStore so changes take effect on the
		// next monitor result rather than being frozen at workflow creation time.
		const freshMaxAttempts = configStore.get().limits.ciFixMaxAttempts;

		if (workflow.ciCycle.attempt >= freshMaxAttempts) {
			const message = result.timedOut
				? `CI monitoring timed out after ${workflow.ciCycle.attempt} fix attempts`
				: `CI checks still failing after ${workflow.ciCycle.attempt} fix attempts`;
			return { kind: "error", message };
		}

		if (allFailuresCancelled(result.results)) {
			const cancelled = result.results.filter((r) => r.bucket === "cancel");
			const names = cancelled.map((r) => r.name).join(", ");
			return {
				kind: "pauseForQuestion",
				question: {
					id: `ci-cancelled-${Date.now()}`,
					content: `All failed CI checks were cancelled (${names}). This may indicate GitHub Actions usage limits. Answer "retry" to re-run monitoring, "abort" to stop the workflow, or type any other text to hand the checks off to the Fixing CI agent together with your note as guidance.`,
					detectedAt: new Date().toISOString(),
				},
			};
		}

		return { kind: "advanceToFixCi" };
	}

	async runFixCi(workflow: Workflow): Promise<CiFlowOutcome> {
		if (!workflow.prUrl) {
			return { kind: "error", message: "No PR URL found — cannot fix CI" };
		}

		const failedChecks = workflow.ciCycle.lastCheckResults.filter((r) => r.bucket !== "pass");

		let logs: CiFailureLog[];
		try {
			logs = await gatherAllFailureLogs(workflow.prUrl, failedChecks);
		} catch (err) {
			return {
				kind: "error",
				message: `Failed to gather CI failure logs: ${toErrorMessage(err)}`,
			};
		}

		const prUrl = workflow.prUrl;
		const guidance = workflow.ciCycle.userFixGuidance;
		let prompt = buildFixPrompt(prUrl, logs);
		if (guidance) {
			prompt = `## USER GUIDANCE (authoritative — the user provided this after monitoring flagged the failing checks)\n\n${guidance}\n\n---\n\n${prompt}`;
		}

		const config = configStore.get();
		return {
			kind: "runCliStep",
			prompt,
			model: config.models.ciFix,
			effort: config.efforts.ciFix,
			failureLogs: logs,
			clearUserFixGuidance: true,
		};
	}

	async startCiMonitoring(workflow: Workflow): Promise<CiFlowOutcome> {
		workflow.ciCycle.monitorStartedAt =
			workflow.ciCycle.monitorStartedAt ?? new Date().toISOString();

		const result = await this.ciMonitor.startMonitoring(workflow, (msg) =>
			this.stepOutput(workflow.id, msg),
		);

		// Cache the latest check results and refresh maxAttempts so subsequent
		// fix-ci runs can read them. handleMonitorResult itself stays pure (it
		// reads but does not mutate); these are the impure wrapper's mutations.
		if (!result.passed) {
			workflow.ciCycle.lastCheckResults = result.results;
			workflow.ciCycle.maxAttempts = configStore.get().limits.ciFixMaxAttempts;
		}

		return this.handleMonitorResult(workflow, result);
	}

	/**
	 * Maps the user's answer to the "all CI checks cancelled" pause-question to
	 * a follow-up outcome:
	 *  - "abort"           → error outcome, workflow stops
	 *  - "retry" / empty   → re-enter monitor-ci
	 *  - any other text    → treated as guidance for the fix-ci agent; advance
	 *                        to fix-ci with the user's answer attached.
	 */
	async answerMonitorCancelledQuestion(
		workflow: Workflow,
		answer: string,
	): Promise<CiFlowOutcome> {
		const normalized = answer.trim().toLowerCase();
		if (normalized === "abort") {
			return { kind: "error", message: "Workflow aborted by user after cancelled CI checks" };
		}
		if (normalized === "retry" || normalized === "") {
			return this.runMonitorCi(workflow);
		}
		workflow.ciCycle.userFixGuidance = answer.trim();
		return { kind: "advanceToFixCi" };
	}

	async runMonitorCi(workflow: Workflow): Promise<CiFlowOutcome> {
		if (!workflow.prUrl) {
			const url = await this.discoverPrUrlFn(workflow);
			if (!url) {
				return { kind: "error", message: "No PR URL found — cannot monitor CI checks" };
			}
			workflow.prUrl = url;
		}

		return this.startCiMonitoring(workflow);
	}

	async handleMergeResult(workflow: Workflow, result: MergeResult): Promise<CiFlowOutcome> {
		if (result.merged || result.alreadyMerged) {
			return { kind: "advance" };
		}

		if (result.conflict) {
			if (workflow.mergeCycle.attempt >= workflow.mergeCycle.maxAttempts) {
				return {
					kind: "error",
					message: `Merge conflicts persist after ${workflow.mergeCycle.attempt} resolution attempts. Resolve the conflict manually or retry with ${workflow.mergeCycle.maxAttempts} more attempts.`,
				};
			}

			const cwd = requireWorktreePath(workflow);
			const resolution = await this.resolveConflictsFn(
				cwd,
				workflow.summary || workflow.specification,
				(msg) => this.stepOutput(workflow.id, msg),
			);

			if (resolution?.kind === "already-up-to-date") {
				this.stepOutput(
					workflow.id,
					"Local tree already up-to-date with master, but GitHub reported a conflict. Retrying merge in case mergeability state was stale.",
				);
				return { kind: "retryMergeAfterAlreadyUpToDate" };
			}

			return { kind: "routeBackToMonitor", incrementMergeAttempt: true };
		}

		return { kind: "error", message: result.error || "PR merge failed" };
	}

	async runMergePr(workflow: Workflow): Promise<CiFlowOutcome> {
		if (!workflow.prUrl) {
			return { kind: "error", message: "No PR URL found — cannot merge PR" };
		}

		// Initialize merge cycle on first entry
		if (workflow.mergeCycle.attempt === 0) {
			workflow.mergeCycle.attempt = 1;
		}

		const cwd = requireWorktreePath(workflow);

		try {
			const result = await this.mergePrFn(workflow.prUrl, cwd, (msg) =>
				this.stepOutput(workflow.id, msg),
			);
			return await this.handleMergeResult(workflow, result);
		} catch (err) {
			return { kind: "error", message: `PR merge failed: ${toErrorMessage(err)}` };
		}
	}

	async retryMergeAfterAlreadyUpToDate(workflow: Workflow): Promise<CiFlowOutcome> {
		if (!workflow.prUrl) {
			return { kind: "error", message: "No PR URL found — cannot retry merge" };
		}
		const cwd = requireWorktreePath(workflow);

		try {
			const retryResult = await this.mergePrFn(workflow.prUrl, cwd, (msg) =>
				this.stepOutput(workflow.id, msg),
			);
			if (retryResult.merged || retryResult.alreadyMerged) {
				return { kind: "advance" };
			}
			if (retryResult.conflict) {
				return {
					kind: "error",
					message:
						"GitHub continues to report a merge conflict even though the local branch already contains origin/master. Resolve the PR manually or investigate squash-merge path-level conflicts.",
				};
			}
			return { kind: "error", message: retryResult.error || "PR merge retry failed" };
		} catch (err) {
			return { kind: "error", message: `PR merge retry failed: ${toErrorMessage(err)}` };
		}
	}

	async runSyncRepo(workflow: Workflow): Promise<CiFlowOutcome> {
		const targetRepo = requireTargetRepository(workflow);

		try {
			const result = await this.syncRepoFn(
				targetRepo,
				workflow.worktreePath,
				this.engine,
				workflow.id,
				(msg) => this.stepOutput(workflow.id, msg),
			);
			if (result.worktreeRemoved) {
				workflow.worktreePath = null;
			}
			if (result.warning) {
				this.stepOutput(workflow.id, `Warning: ${result.warning}`);
			}
		} catch (err) {
			// Even on error, sync-repo completes (PR is already merged)
			this.stepOutput(workflow.id, `Warning: sync failed: ${toErrorMessage(err)}`);
		}
		return { kind: "advance" };
	}
}
