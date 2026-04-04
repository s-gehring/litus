import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	AppConfig,
	ConfigValidationError,
	ConfigWarning,
	NumericSettingMeta,
	PromptConfig,
	PromptVariableInfo,
} from "./types";

export const DEFAULT_CONFIG: AppConfig = {
	models: {
		questionDetection: "claude-haiku-4-5-20251001",
		reviewClassification: "claude-haiku-4-5-20251001",
		activitySummarization: "claude-haiku-4-5-20251001",
		specSummarization: "claude-haiku-4-5-20251001",
	},
	prompts: {
		questionDetection:
			'Is this text a question directed at the user that requires their input to proceed? Answer only "yes" or "no".\n\nText: "${text}"',
		reviewClassification: `Classify the highest severity of issues found in this code review. Answer with exactly one word: critical, major, minor, trivial, or nit.

- critical: Security vulnerabilities, data loss, crashes
- major: Missing error handling, broken functionality, logic errors
- minor: Code style issues, missing tests, small improvements
- trivial: Whitespace, formatting, naming preferences
- nit: Suggestions, opinions, optional improvements

Review output:
\${reviewOutput}`,
		activitySummarization:
			"Summarize what this coding agent is currently doing in 3-6 words. Output only the summary, nothing else.\n\n${text}",
		specSummarization: `You are given a feature specification. Return a JSON object with two fields:
- "summary": a 2-5 word description of the feature
- "flavor": a 4-10 word snarky, insulting comment about the feature

Output ONLY valid JSON, nothing else.

Specification:
\${specification}`,
		mergeConflictResolution: `The feature branch has merge conflicts with master. Resolve all merge conflicts in this repository.

Feature summary: \${specSummary}

Steps:
1. Find all files with conflict markers (<<<<<<< / ======= / >>>>>>>)
2. Resolve each conflict by keeping the correct combination of both sides
3. Run: git add .
4. Run: git commit -m "chore: resolve merge conflicts with master"
5. Run: git push`,
		ciFixInstruction: `The following CI checks failed on PR \${prUrl}:

\${logSections}

Fix these CI failures. After fixing, commit and push the changes.`,
	},
	limits: {
		reviewCycleMaxIterations: 16,
		ciFixMaxAttempts: 3,
		mergeMaxAttempts: 3,
	},
	timing: {
		ciGlobalTimeoutMs: 1_800_000,
		ciPollIntervalMs: 15_000,
		questionDetectionCooldownMs: 15_000,
		activitySummaryIntervalMs: 15_000,
		rateLimitBackoffMs: 60_000,
		maxCiLogLength: 50_000,
		maxClientOutputLines: 5_000,
	},
};

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
		key: "timing.questionDetectionCooldownMs",
		label: "Question Detection Cooldown",
		description: "Minimum time between question detection attempts",
		min: 1_000,
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
];

export class ConfigStore {
	private configPath: string;
	private savedConfig: Partial<AppConfig> | null = null;

	constructor(configPath?: string) {
		this.configPath = configPath ?? join(homedir(), ".crab-studio", "config.json");
		this.load();
	}

	get(): AppConfig {
		const saved = this.savedConfig ?? {};
		return {
			models: { ...DEFAULT_CONFIG.models, ...(saved.models ?? {}) },
			prompts: { ...DEFAULT_CONFIG.prompts, ...(saved.prompts ?? {}) },
			limits: { ...DEFAULT_CONFIG.limits, ...(saved.limits ?? {}) },
			timing: { ...DEFAULT_CONFIG.timing, ...(saved.timing ?? {}) },
		};
	}

	save(partial: Partial<AppConfig>): {
		errors: ConfigValidationError[];
		warnings: ConfigWarning[];
	} {
		const errors = this.validate(partial);
		if (errors.length > 0) {
			return { errors, warnings: [] };
		}

		// Merge partial into saved config
		const current = this.savedConfig ?? {};
		if (partial.models) {
			current.models = { ...(current.models ?? {}), ...partial.models };
		}
		if (partial.prompts) {
			current.prompts = { ...(current.prompts ?? {}), ...partial.prompts };
		}
		if (partial.limits) {
			current.limits = { ...(current.limits ?? {}), ...partial.limits };
		}
		if (partial.timing) {
			current.timing = { ...(current.timing ?? {}), ...partial.timing };
		}
		this.savedConfig = current;

		const warnings = this.checkPromptVariables(partial);
		this.writeToDisk();
		return { errors: [], warnings };
	}

	reset(key?: string): void {
		if (!key) {
			this.savedConfig = null;
			this.writeToDisk();
			return;
		}

		if (!this.savedConfig) return;

		const parts = key.split(".");
		if (parts.length === 1) {
			// Reset whole section
			delete (this.savedConfig as Record<string, unknown>)[parts[0]];
		} else if (parts.length === 2) {
			const section = (this.savedConfig as Record<string, Record<string, unknown>>)[parts[0]];
			if (section) {
				delete section[parts[1]];
				// If section is now empty, remove it
				if (Object.keys(section).length === 0) {
					delete (this.savedConfig as Record<string, unknown>)[parts[0]];
				}
			}
		}

		this.writeToDisk();
	}

	private load(): void {
		try {
			if (!existsSync(this.configPath)) {
				this.savedConfig = null;
				return;
			}
			const text = readFileSync(this.configPath, "utf-8");
			const parsed = JSON.parse(text);
			if (typeof parsed === "object" && parsed !== null) {
				this.savedConfig = parsed;
			} else {
				this.savedConfig = null;
			}
		} catch {
			console.warn("[config] Failed to load config.json, using defaults");
			this.savedConfig = null;
		}
	}

	private writeToDisk(): void {
		const dir = dirname(this.configPath);
		mkdirSync(dir, { recursive: true });

		const data = this.savedConfig ? JSON.stringify(this.savedConfig, null, 2) : "{}";
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const tmpPath = `${this.configPath}.${suffix}.tmp`;

		try {
			writeFileSync(tmpPath, data);
			renameSync(tmpPath, this.configPath);
		} catch (err) {
			console.error(`[config] Failed to write config: ${err}`);
			try {
				unlinkSync(tmpPath);
			} catch {
				/* ignore */
			}
		}
	}

	private validate(partial: Partial<AppConfig>): ConfigValidationError[] {
		const errors: ConfigValidationError[] = [];

		if (partial.models) {
			for (const [key, value] of Object.entries(partial.models)) {
				if (typeof value !== "string" || value.trim() === "") {
					errors.push({
						path: `models.${key}`,
						message: "Must be a non-empty string",
						value,
					});
				}
			}
		}

		if (partial.prompts) {
			for (const [key, value] of Object.entries(partial.prompts)) {
				if (typeof value !== "string" || value.trim() === "") {
					errors.push({
						path: `prompts.${key}`,
						message: "Must be a non-empty string",
						value,
					});
				}
			}
		}

		if (partial.limits) {
			this.validateNumericSection(
				partial.limits as unknown as Record<string, unknown>,
				"limits",
				errors,
			);
		}

		if (partial.timing) {
			this.validateNumericSection(
				partial.timing as unknown as Record<string, unknown>,
				"timing",
				errors,
			);
		}

		return errors;
	}

	private validateNumericSection(
		section: Record<string, unknown>,
		sectionName: string,
		errors: ConfigValidationError[],
	): void {
		for (const [key, value] of Object.entries(section)) {
			if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
				errors.push({
					path: `${sectionName}.${key}`,
					message: "Must be a positive integer",
					value,
				});
				continue;
			}

			const meta = NUMERIC_SETTING_META.find((m) => m.key === `${sectionName}.${key}`);
			if (meta && value < meta.min) {
				errors.push({
					path: `${sectionName}.${key}`,
					message: `Must be at least ${meta.min}`,
					value,
				});
			}
		}
	}

	private checkPromptVariables(partial: Partial<AppConfig>): ConfigWarning[] {
		const warnings: ConfigWarning[] = [];

		if (!partial.prompts) return warnings;

		for (const [key, value] of Object.entries(partial.prompts)) {
			if (typeof value !== "string") continue;

			const variables = PROMPT_VARIABLES[key as keyof typeof PROMPT_VARIABLES];
			if (!variables) continue;

			const missing = variables.filter((v) => !value.includes(`\${${v.name}}`)).map((v) => v.name);

			if (missing.length > 0) {
				warnings.push({
					path: `prompts.${key}`,
					missingVariables: missing,
					message: `Template variable(s) ${missing.map((v) => `\${${v}}`).join(", ")} not present in the prompt`,
				});
			}
		}

		return warnings;
	}
}

export const configStore = new ConfigStore();
