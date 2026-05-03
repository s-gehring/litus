// ── Aspect runner ─────────────────────────────────────────
//
// Per-aspect dispatch pool wrapping the generalized CLIRunner. Owns slot/cap
// accounting and promote-on-slot for the research-aspect step of the
// ask-question pipeline (FR-001, FR-012). The CLI/audit/idle plumbing stays
// in CLIRunner; this module only adds the in-memory pool layer.
//
// One pool per workflow id: the orchestrator calls `dispatch` on entry to the
// research-aspect step (and again on retry for errored-only aspects), and
// `promoteNext` from each aspect's terminal callback. Cap is read by the
// caller from `configStore.get().limits.askQuestionConcurrentAspects` and
// clamped per data-model.md §4.

import { buildResearchPrompt } from "./aspect-researcher";
import { aspectProcessKey, type CLICallbacks, type CLIRunner } from "./cli-runner";
import type { EffortLevel } from "./config-types";
import { logger } from "./logger";
import type { AspectState, ToolUsage, Workflow } from "./types";

export interface AspectRunnerCallbacks {
	onAspectStart: (aspectId: string) => void;
	onAspectOutput: (aspectId: string, text: string) => void;
	onAspectTools: (aspectId: string, tools: ToolUsage[]) => void;
	onAspectSessionId: (aspectId: string, sessionId: string) => void;
	onAspectComplete: (aspectId: string) => void;
	onAspectError: (aspectId: string, message: string) => void;
}

export interface AspectDispatchEnv {
	cwd: string;
	promptTemplate: string;
	model: string | undefined;
	effort: EffortLevel | undefined;
	extraEnv?: Record<string, string>;
}

export class AspectRunner {
	private cliRunner: CLIRunner;
	/** Per-workflow set of aspect ids currently in_progress under this runner. */
	private active: Map<string, Set<string>> = new Map();

	constructor(cliRunner: CLIRunner) {
		this.cliRunner = cliRunner;
	}

	/**
	 * Dispatch up to `cap` of the supplied pending aspects in manifest order.
	 * Caller is responsible for filtering `aspectsToDispatch` to aspects whose
	 * `status === "pending"` (see orchestrator). Returns the ids actually
	 * started this call.
	 */
	dispatch(
		workflow: Workflow,
		aspectsToDispatch: AspectState[],
		cap: number,
		env: AspectDispatchEnv,
		callbacks: AspectRunnerCallbacks,
	): string[] {
		const active = this.activeSet(workflow.id);
		const slotsAvailable = Math.max(0, cap - active.size);
		const toStartNow = aspectsToDispatch.slice(0, slotsAvailable);
		const started: string[] = [];
		for (const aspect of toStartNow) {
			this.startAspect(workflow, aspect, env, callbacks);
			started.push(aspect.id);
		}
		return started;
	}

	/**
	 * Promote the next pending aspect (in manifest order, filtered by the
	 * caller) into a free slot. Called from the orchestrator's per-aspect
	 * terminal callback. Returns the aspect id that started, or null if no
	 * slot was free / no pending aspect was provided.
	 */
	promoteNext(
		workflow: Workflow,
		pendingAspects: AspectState[],
		cap: number,
		env: AspectDispatchEnv,
		callbacks: AspectRunnerCallbacks,
	): string | null {
		const active = this.activeSet(workflow.id);
		if (active.size >= cap) return null;
		const next = pendingAspects.find((a) => !active.has(a.id));
		if (!next) return null;
		this.startAspect(workflow, next, env, callbacks);
		return next.id;
	}

	/** Number of aspect processes currently in-flight for this workflow. */
	inFlightCount(workflowId: string): number {
		return this.active.get(workflowId)?.size ?? 0;
	}

	/** Snapshot of in-flight aspect ids for this workflow (test helper). */
	inFlightIds(workflowId: string): string[] {
		return Array.from(this.active.get(workflowId) ?? []);
	}

	/** Kill every aspect process for this workflow and clear its pool. */
	killAllForWorkflow(workflowId: string): void {
		this.cliRunner.killAllForWorkflow(workflowId);
		this.active.delete(workflowId);
	}

	private activeSet(workflowId: string): Set<string> {
		let s = this.active.get(workflowId);
		if (!s) {
			s = new Set();
			this.active.set(workflowId, s);
		}
		return s;
	}

	private startAspect(
		workflow: Workflow,
		aspect: AspectState,
		env: AspectDispatchEnv,
		callbacks: AspectRunnerCallbacks,
	): void {
		const manifest = workflow.aspectManifest;
		const entry = manifest?.aspects.find((a) => a.id === aspect.id);
		if (!entry) {
			queueMicrotask(() =>
				callbacks.onAspectError(
					aspect.id,
					`Inconsistent aspect state — no manifest entry for id ${aspect.id}`,
				),
			);
			return;
		}

		const prompt = buildResearchPrompt(env.promptTemplate, {
			aspectTitle: entry.title,
			aspectResearchPrompt: entry.researchPrompt,
			aspectFileName: entry.fileName,
		});

		// CLIRunner expects a Workflow whose `specification` is the prompt and
		// whose `worktreePath` is the cwd to spawn in. We synthesise a shallow
		// copy so the real workflow isn't mutated.
		const dispatchWorkflow: Workflow = {
			...workflow,
			specification: prompt,
			worktreePath: env.cwd,
		};

		const active = this.activeSet(workflow.id);
		active.add(aspect.id);

		// Fire start callback BEFORE spawning so the orchestrator can flip
		// status → in_progress, persist, and broadcast workflow:aspect:state
		// before the first stream token arrives.
		callbacks.onAspectStart(aspect.id);

		const cliCallbacks: CLICallbacks = {
			onOutput: (text) => callbacks.onAspectOutput(aspect.id, text),
			onTools: (tools) => callbacks.onAspectTools(aspect.id, tools),
			onSessionId: (id) => callbacks.onAspectSessionId(aspect.id, id),
			onComplete: () => {
				active.delete(aspect.id);
				try {
					callbacks.onAspectComplete(aspect.id);
				} catch (err) {
					logger.error(`[aspect-runner] onAspectComplete threw for ${aspect.id}: ${String(err)}`);
				}
			},
			onError: (err) => {
				active.delete(aspect.id);
				try {
					callbacks.onAspectError(aspect.id, err);
				} catch (cbErr) {
					logger.error(`[aspect-runner] onAspectError threw for ${aspect.id}: ${String(cbErr)}`);
				}
			},
		};

		this.cliRunner.start(dispatchWorkflow, cliCallbacks, env.extraEnv, env.model, env.effort, {
			processKey: aspectProcessKey(workflow.id, aspect.id),
			aspectId: aspect.id,
		});
	}
}
