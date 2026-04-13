import type { NumericSettingMeta, PromptConfig, PromptVariableInfo } from "./types";

export const PROMPT_VARIABLES: Record<keyof PromptConfig, PromptVariableInfo[]> = {
	questionDetection: [{ name: "text", description: "The text being analyzed for questions" }],
	reviewClassification: [
		{ name: "reviewOutput", description: "The code review output to classify" },
	],
	activitySummarization: [{ name: "text", description: "Recent agent output to summarize" }],
	specSummarization: [{ name: "specification", description: "The feature specification text" }],
	mergeConflictResolution: [
		{ name: "specSummary", description: "Summary of the feature being implemented" },
	],
	ciFixInstruction: [
		{ name: "prUrl", description: "The pull request URL" },
		{ name: "logSections", description: "Formatted CI failure log sections" },
	],
	epicDecomposition: [
		{ name: "epicDescription", description: "The epic description to decompose into specs" },
	],
	feedbackImplementerInstruction: [
		{
			name: "feedbackContext",
			description: "All prior user feedback entries labelled authoritative",
		},
		{ name: "priorOutcomes", description: "Summary + commit refs from prior feedback iterations" },
		{ name: "latestFeedbackText", description: "The user's most recent feedback text" },
		{ name: "prUrl", description: "The pull request URL" },
	],
};

export const NUMERIC_SETTING_META: NumericSettingMeta[] = [
	{
		key: "limits.reviewCycleMaxIterations",
		label: "Review Cycle Max Iterations",
		description: "Maximum number of review-fix iterations before advancing",
		min: 1,
		defaultValue: 16,
		unit: "iterations",
	},
	{
		key: "limits.ciFixMaxAttempts",
		label: "CI Fix Max Attempts",
		description: "Maximum number of CI fix attempts before giving up",
		min: 1,
		defaultValue: 3,
		unit: "attempts",
	},
	{
		key: "limits.mergeMaxAttempts",
		label: "Merge Max Attempts",
		description: "Maximum number of merge conflict resolution attempts",
		min: 1,
		defaultValue: 3,
		unit: "attempts",
	},
	{
		key: "limits.maxJsonRetries",
		label: "Max JSON Retries",
		description: "Maximum retry attempts when epic analysis returns unparseable JSON",
		min: 0,
		defaultValue: 2,
		unit: "retries",
	},
	{
		key: "timing.ciGlobalTimeoutMs",
		label: "CI Global Timeout",
		description: "Maximum time to wait for CI checks to complete",
		min: 60_000,
		defaultValue: 1_800_000,
		unit: "ms",
	},
	{
		key: "timing.ciPollIntervalMs",
		label: "CI Poll Interval",
		description: "How often to poll CI check status",
		min: 5_000,
		defaultValue: 15_000,
		unit: "ms",
	},
	{
		key: "timing.activitySummaryIntervalMs",
		label: "Activity Summary Interval",
		description: "Minimum time between activity summary generation",
		min: 5_000,
		defaultValue: 15_000,
		unit: "ms",
	},
	{
		key: "timing.rateLimitBackoffMs",
		label: "Rate Limit Backoff",
		description: "Wait time when rate limited by GitHub API",
		min: 10_000,
		defaultValue: 60_000,
		unit: "ms",
	},
	{
		key: "timing.maxCiLogLength",
		label: "Max CI Log Length",
		description: "Maximum characters of CI log to include in fix prompt",
		min: 1_000,
		defaultValue: 50_000,
		unit: "chars",
	},
	{
		key: "timing.maxClientOutputLines",
		label: "Max Client Output Lines",
		description: "Maximum number of output lines kept in the browser",
		min: 100,
		defaultValue: 5_000,
		unit: "lines",
	},
	{
		key: "timing.epicTimeoutMs",
		label: "Epic Analysis Timeout",
		description: "Maximum time to wait for epic decomposition analysis",
		min: 60_000,
		defaultValue: 900_000,
		unit: "ms",
	},
	{
		key: "timing.cliIdleTimeoutMs",
		label: "CLI Idle Timeout",
		description: "Kill CLI process if no output received within this period (0 to disable)",
		min: 0,
		defaultValue: 600_000,
		unit: "ms",
	},
];
