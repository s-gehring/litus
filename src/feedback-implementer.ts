import { buildFeedbackContext } from "./feedback-injector";
import { gitSpawn } from "./git-logger";
import { logger } from "./logger";
import {
	type AppConfig,
	type FeedbackOutcome,
	type FeedbackOutcomeValue,
	type FeedbackOutcomeWarning,
	STEP,
	type Workflow,
} from "./types";

const SENTINEL_PATTERN =
	/<<<FEEDBACK_IMPLEMENTER_RESULT\s*([\s\S]*?)\s*FEEDBACK_IMPLEMENTER_RESULT>>>/g;

export interface PrDescriptionUpdateResult {
	attempted: boolean;
	succeeded: boolean;
	errorMessage: string | null;
}

export interface ParsedAgentResult {
	sentinelFound: boolean;
	outcome: "success" | "no changes" | "failed" | null;
	summary: string;
	materiallyRelevant: boolean;
	prDescriptionUpdate: PrDescriptionUpdateResult | null;
}

/** Build the optional "Prior feedback-implementer outcome records" section for the prompt. */
export function buildPriorOutcomesSection(workflow: Workflow): string {
	const completed = workflow.feedbackEntries.filter((e) => e.outcome !== null);
	if (completed.length === 0) return "";

	const lines: string[] = ["## Prior feedback-implementer outcome records", ""];
	for (const entry of completed) {
		const o = entry.outcome as FeedbackOutcome;
		const commits = o.commitRefs.length > 0 ? o.commitRefs.join(", ") : "(no commits)";
		lines.push(`- Iteration ${entry.iteration} (${o.value}): ${o.summary} — commits: ${commits}`);
		for (const w of o.warnings) {
			lines.push(`  • warning ${w.kind}: ${w.message}`);
		}
	}
	return lines.join("\n");
}

/** Build the prompt for the feedback-implementer agent from the config template. */
export function buildFeedbackPrompt(
	config: AppConfig,
	workflow: Workflow,
	latestFeedbackText: string,
	prUrl: string,
): string {
	const template = config.prompts.feedbackImplementerInstruction;
	// Drop the in-flight entry from the context so the agent doesn't see its own
	// pending feedback twice — once here as "in progress", once via
	// ${latestFeedbackText}.
	const feedbackContext = buildFeedbackContext(workflow, { excludeInFlight: true });
	const priorOutcomes = buildPriorOutcomesSection(workflow);

	return template
		.replaceAll("${feedbackContext}", feedbackContext)
		.replaceAll("${priorOutcomes}", priorOutcomes)
		.replaceAll("${latestFeedbackText}", latestFeedbackText)
		.replaceAll("${prUrl}", prUrl);
}

/**
 * Run `git rev-list <preRunHead>..HEAD --reverse` in the worktree and return
 * the new commit SHAs in chronological order. Returns [] on any error or when
 * preRunHead is empty.
 */
export async function detectNewCommits(preRunHead: string, cwd: string): Promise<string[]> {
	if (!preRunHead || !cwd) return [];
	try {
		const result = await gitSpawn(["git", "rev-list", `${preRunHead}..HEAD`, "--reverse"], {
			cwd,
			extra: { preRunHead },
		});
		if (result.code !== 0 || !result.stdout) return [];
		return result.stdout
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	} catch {
		return [];
	}
}

/**
 * Parse the last `<<<FEEDBACK_IMPLEMENTER_RESULT ... FEEDBACK_IMPLEMENTER_RESULT>>>`
 * sentinel block from agent output. Returns `sentinelFound: false` when no block
 * is present or the block contains invalid JSON.
 */
export function parseAgentResult(output: string): ParsedAgentResult {
	const matches = Array.from(output.matchAll(SENTINEL_PATTERN));
	if (matches.length === 0) {
		return {
			sentinelFound: false,
			outcome: null,
			summary: "",
			materiallyRelevant: false,
			prDescriptionUpdate: null,
		};
	}

	const last = matches[matches.length - 1][1].trim();
	try {
		const parsed = JSON.parse(last) as {
			outcome?: string;
			summary?: string;
			materiallyRelevant?: boolean;
			prDescriptionUpdate?: {
				attempted?: boolean;
				succeeded?: boolean;
				errorMessage?: string | null;
			} | null;
		};

		let outcome: "success" | "no changes" | "failed" | null = null;
		if (parsed.outcome === "success") outcome = "success";
		else if (parsed.outcome === "no changes") outcome = "no changes";
		else if (parsed.outcome === "failed") outcome = "failed";
		else if (parsed.outcome !== undefined && parsed.outcome !== null) {
			// Unrecognized value — a customised prompt or buggy agent can silently
			// downgrade `failed` to `no changes` via the reconcile fallback. Log
			// so future mis-customisations are diagnosable.
			logger.warn(
				`[feedback-implementer] Unrecognized outcome value in sentinel: ${JSON.stringify(parsed.outcome)}; falling back to git-based inference`,
			);
		}

		const raw = parsed.prDescriptionUpdate;
		const prDescriptionUpdate: PrDescriptionUpdateResult | null =
			raw && typeof raw.attempted === "boolean"
				? {
						attempted: raw.attempted,
						succeeded: !!raw.succeeded,
						errorMessage: typeof raw.errorMessage === "string" ? raw.errorMessage : null,
					}
				: null;

		return {
			sentinelFound: true,
			outcome,
			summary: typeof parsed.summary === "string" ? parsed.summary : "",
			materiallyRelevant: !!parsed.materiallyRelevant,
			prDescriptionUpdate,
		};
	} catch {
		return {
			sentinelFound: false,
			outcome: null,
			summary: "",
			materiallyRelevant: false,
			prDescriptionUpdate: null,
		};
	}
}

/**
 * Recovery helper for interrupted feedback-implementer runs (FR-020). Mutates
 * the workflow in place to: mark the in-flight entry cancelled with summary
 * "Interrupted by server restart", reset the feedback-implementer step to
 * pending, rewind currentStepIndex to merge-pr, and set both step and workflow
 * status to paused. Also clears feedbackPreRunHead — the next iteration starts
 * fresh.
 *
 * Ordering convention: all per-step mutations happen first, workflow-level
 * status (`status`, `activeWorkStartedAt`, `updatedAt`) is set last. If a
 * future change introduces an intermediate persistence call, the workflow
 * won't briefly be observed as `running` while internal fields are already
 * rewound.
 */
export function recoverInterruptedFeedbackImplementer(workflow: Workflow): void {
	const latest = workflow.feedbackEntries[workflow.feedbackEntries.length - 1];
	if (latest && latest.outcome === null) {
		latest.outcome = {
			value: "cancelled",
			summary: "Interrupted by server restart",
			commitRefs: [],
			warnings: [],
		};
	}
	const fiIdx = workflow.steps.findIndex((s) => s.name === STEP.FEEDBACK_IMPLEMENTER);
	if (fiIdx >= 0) {
		const fiStep = workflow.steps[fiIdx];
		fiStep.status = "pending";
		fiStep.sessionId = null;
		fiStep.output = "";
		fiStep.error = null;
		fiStep.startedAt = null;
		fiStep.completedAt = null;
		fiStep.pid = null;
	}
	const mergeIdx = workflow.steps.findIndex((s) => s.name === STEP.MERGE_PR);
	if (mergeIdx >= 0) {
		const mergeStep = workflow.steps[mergeIdx];
		mergeStep.status = "paused";
		workflow.currentStepIndex = mergeIdx;
	}
	workflow.feedbackPreRunHead = null;
	workflow.status = "paused";
	workflow.activeWorkStartedAt = null;
	workflow.updatedAt = new Date().toISOString();
}

/**
 * Reconcile the parsed agent result with ground truth from git to produce the
 * final `FeedbackOutcome`. Commits are authoritative: if any landed, the outcome
 * is `success`, regardless of what the sentinel reports (a post-commit PR-edit
 * failure becomes a non-fatal warning, not a `failed` outcome). When no commits
 * landed, the agent-reported sentinel outcome (`failed` vs `no changes`) is
 * honored; absent sentinel the outcome defaults to `failed` when the CLI exited
 * non-zero, otherwise `no changes`.
 */
export function reconcileOutcome(
	parsed: ParsedAgentResult,
	commitRefs: string[],
	cliFailed: boolean,
): FeedbackOutcome {
	const warnings: FeedbackOutcomeWarning[] = [];

	if (parsed.prDescriptionUpdate?.attempted && parsed.prDescriptionUpdate.succeeded === false) {
		warnings.push({
			kind: "pr_description_update_failed",
			message: parsed.prDescriptionUpdate.errorMessage ?? "PR description update failed",
		});
	}

	if (commitRefs.length > 0) {
		const value: FeedbackOutcomeValue = "success";
		return {
			value,
			summary: parsed.summary || "Applied feedback",
			commitRefs,
			warnings,
		};
	}
	if (cliFailed || parsed.outcome === "failed") {
		return {
			value: "failed",
			summary: parsed.summary || "Feedback implementer failed",
			commitRefs: [],
			warnings,
		};
	}
	return {
		value: "no changes",
		summary: parsed.summary || "No changes produced",
		commitRefs: [],
		warnings,
	};
}
