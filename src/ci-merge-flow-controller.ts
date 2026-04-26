import type { MonitorResult } from "./ci-monitor";
import type { CIMonitorCoordinator } from "./ci-monitor-coordinator";
import type {
	mergePr as defaultMergePr,
	resolveConflicts as defaultResolveConflicts,
} from "./pr-merger";
import type { syncRepo as defaultSyncRepo } from "./repo-syncer";
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
	| {
			kind: "syncCompleted";
			worktreeRemoved: boolean;
			warning: string | null;
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
}
