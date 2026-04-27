// ── Application configuration ─────────────────────────────
//
// Persisted user-tunable configuration: model selection per step, effort
// levels, prompt templates, numeric limits/timings, and the global auto-mode
// switch. Includes the validation/warning shapes used by the config UI and
// the audit-log directory override. Independent of the workflow domain so
// the config UI can render and validate without pulling in workflow types.

// ── Utility types ─────────────────────────────────────────

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface ModelConfig {
	// Lightweight models (required, non-empty)
	questionDetection: string;
	reviewClassification: string;
	activitySummarization: string;
	specSummarization: string;
	// Workflow step models (optional, empty = use CLI default)
	epicDecomposition: string;
	mergeConflictResolution: string;
	ciFix: string;
	specify: string;
	clarify: string;
	plan: string;
	tasks: string;
	implement: string;
	review: string;
	implementReview: string;
	artifacts: string;
	commitPushPr: string;
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface EffortConfig {
	// Lightweight models — default "low"
	questionDetection: EffortLevel;
	reviewClassification: EffortLevel;
	activitySummarization: EffortLevel;
	specSummarization: EffortLevel;
	// Workflow step models — default "medium"
	epicDecomposition: EffortLevel;
	mergeConflictResolution: EffortLevel;
	ciFix: EffortLevel;
	specify: EffortLevel;
	clarify: EffortLevel;
	plan: EffortLevel;
	tasks: EffortLevel;
	implement: EffortLevel;
	review: EffortLevel;
	implementReview: EffortLevel;
	artifacts: EffortLevel;
	commitPushPr: EffortLevel;
}

export interface PromptConfig {
	questionDetection: string;
	reviewClassification: string;
	activitySummarization: string;
	specSummarization: string;
	mergeConflictResolution: string;
	ciFixInstruction: string;
	epicDecomposition: string;
	feedbackImplementerInstruction: string;
}

export interface LimitConfig {
	reviewCycleMaxIterations: number;
	ciFixMaxAttempts: number;
	mergeMaxAttempts: number;
	maxJsonRetries: number;
	artifactsPerFileMaxBytes: number;
	artifactsPerStepMaxBytes: number;
}

export interface TimingConfig {
	ciGlobalTimeoutMs: number;
	ciPollIntervalMs: number;
	activitySummaryIntervalMs: number;
	rateLimitBackoffMs: number;
	maxCiLogLength: number;
	maxClientOutputLines: number;
	epicTimeoutMs: number;
	cliIdleTimeoutMs: number;
	artifactsTimeoutMs: number;
}

export type AutoMode = "manual" | "normal" | "full-auto";

export function shouldAutoAnswer(mode: AutoMode): boolean {
	return mode === "full-auto";
}

export function shouldPauseBeforeMerge(mode: AutoMode): boolean {
	return mode === "manual";
}

export interface AppConfig {
	models: ModelConfig;
	efforts: EffortConfig;
	prompts: PromptConfig;
	limits: LimitConfig;
	timing: TimingConfig;
	autoMode: AutoMode;
}

export interface PromptVariableInfo {
	name: string;
	description: string;
}

// Signals the config UI how to render a numeric setting. "scalar" (default) is
// the existing numeric-only spinner. "size" means bytes canonical, rendered as
// a numeric + MB/GB selector. "duration" means ms canonical, rendered as a
// numeric + minutes/hours selector. Raw bytes/seconds MUST NOT be the sole
// input variant for "size"/"duration" entries (FR-013a, FR-016).
export type NumericSettingInputKind = "scalar" | "size" | "duration";

export interface NumericSettingMeta {
	key: string;
	label: string;
	description: string;
	min: number;
	defaultValue: number;
	unit?: string;
	inputKind?: NumericSettingInputKind;
}

export interface ConfigValidationError {
	path: string;
	message: string;
	value: unknown;
}

export interface ConfigWarning {
	path: string;
	missingVariables: string[];
	message: string;
}

export interface AuditConfig {
	auditDir?: string;
}
