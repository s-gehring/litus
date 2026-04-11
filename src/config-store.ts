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
import { NUMERIC_SETTING_META, PROMPT_VARIABLES } from "./config-metadata";
import { logger } from "./logger";
import type {
	AppConfig,
	AutoMode,
	ConfigValidationError,
	ConfigWarning,
	DeepPartial,
	EffortLevel,
} from "./types";

export const DEFAULT_CONFIG: AppConfig = {
	models: {
		questionDetection: "claude-haiku-4-5-20251001",
		reviewClassification: "claude-haiku-4-5-20251001",
		activitySummarization: "claude-haiku-4-5-20251001",
		specSummarization: "claude-haiku-4-5-20251001",
		epicDecomposition: "",
		mergeConflictResolution: "",
		ciFix: "",
		specify: "",
		clarify: "",
		plan: "",
		tasks: "",
		implement: "",
		review: "",
		implementReview: "",
		commitPushPr: "",
	},
	efforts: {
		questionDetection: "low",
		reviewClassification: "low",
		activitySummarization: "low",
		specSummarization: "low",
		epicDecomposition: "medium",
		mergeConflictResolution: "medium",
		ciFix: "medium",
		specify: "medium",
		clarify: "medium",
		plan: "medium",
		tasks: "medium",
		implement: "medium",
		review: "medium",
		implementReview: "medium",
		commitPushPr: "medium",
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
		epicDecomposition: `You are analyzing a codebase to decompose a large feature epic into multiple
self-contained implementation specifications.

## Epic Description

\${epicDescription}

## Instructions

1. Analyze the current codebase structure, patterns, and architecture.
2. Decompose the epic into the smallest set of self-contained specifications
   that together deliver the full scope of the epic.
3. Each spec MUST be independently implementable and testable.
4. Identify dependency relationships: if spec B requires changes from spec A
   to exist first, B depends on A.
5. Avoid circular dependencies.
6. If any part of the epic is infeasible given the current codebase, note it.

## Output Format

Return ONLY a JSON code block with this exact structure:

\`\`\`json
{
  "title": "Short epic title",
  "summary": "A 1-3 paragraph overview of the decomposition: what the epic achieves, how the specs relate to each other, and any important architectural decisions or trade-offs.",
  "specs": [
    {
      "id": "a",
      "title": "Short spec title",
      "description": "Full specification description for this piece",
      "dependencies": []
    },
    {
      "id": "b",
      "title": "Another spec title",
      "description": "Full specification description",
      "dependencies": ["a"]
    }
  ],
  "infeasibleNotes": null
}
\`\`\`

Rules:
- \`id\` values are simple lowercase letters (a, b, c, ...)
- \`dependencies\` reference other spec \`id\` values within this decomposition
- \`description\` should be detailed enough to serve as a specification input
- \`summary\` must be a human-readable overview (1-3 paragraphs, markdown allowed)
- If the epic is already atomic (cannot be split), return a single spec
- If parts are infeasible, set \`infeasibleNotes\` to explain why
- If the ENTIRE epic is infeasible, \`specs\` can be an empty array with \`infeasibleNotes\` explaining why`,
	},
	autoMode: "normal",
	limits: {
		reviewCycleMaxIterations: 16,
		ciFixMaxAttempts: 3,
		mergeMaxAttempts: 3,
		maxJsonRetries: 2,
	},
	timing: {
		ciGlobalTimeoutMs: 1_800_000,
		ciPollIntervalMs: 15_000,
		activitySummaryIntervalMs: 15_000,
		rateLimitBackoffMs: 60_000,
		maxCiLogLength: 50_000,
		maxClientOutputLines: 5_000,
		epicTimeoutMs: 900_000,
		cliIdleTimeoutMs: 600_000,
	},
};

export { NUMERIC_SETTING_META, PROMPT_VARIABLES } from "./config-metadata";

export class ConfigStore {
	private configPath: string;
	private savedConfig: Partial<AppConfig> | null = null;

	constructor(configPath?: string) {
		this.configPath = configPath ?? join(homedir(), ".litus", "config.json");
		this.load();
	}

	get(): AppConfig {
		const saved = this.savedConfig ?? {};
		return {
			models: { ...DEFAULT_CONFIG.models, ...(saved.models ?? {}) },
			efforts: { ...DEFAULT_CONFIG.efforts, ...(saved.efforts ?? {}) },
			prompts: { ...DEFAULT_CONFIG.prompts, ...(saved.prompts ?? {}) },
			limits: { ...DEFAULT_CONFIG.limits, ...(saved.limits ?? {}) },
			timing: { ...DEFAULT_CONFIG.timing, ...(saved.timing ?? {}) },
			autoMode: saved.autoMode ?? DEFAULT_CONFIG.autoMode,
		};
	}

	save(partial: DeepPartial<AppConfig>): {
		errors: ConfigValidationError[];
		warnings: ConfigWarning[];
	} {
		const errors = this.validate(partial);
		if (errors.length > 0) {
			return { errors, warnings: [] };
		}

		// Merge partial into saved config
		const current = this.savedConfig ?? {};
		const obj = current as Record<string, Record<string, unknown> | undefined>;
		const src = partial as Record<string, Record<string, unknown> | undefined>;
		for (const key of ["models", "efforts", "prompts", "limits", "timing"]) {
			if (src[key]) {
				obj[key] = { ...(obj[key] ?? {}), ...src[key] };
			}
		}
		if (partial.autoMode !== undefined) {
			current.autoMode = partial.autoMode;
		}
		this.savedConfig = current;

		const warnings = this.checkPromptVariables(partial);
		if (!this.writeToDisk()) {
			return {
				errors: [{ path: "_disk", message: "Failed to persist config to disk", value: undefined }],
				warnings,
			};
		}
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
				// Migrate boolean autoMode to enum
				if (typeof parsed.autoMode === "boolean") {
					parsed.autoMode = parsed.autoMode ? "full-auto" : "normal";
				}
				this.savedConfig = parsed;
			} else {
				this.savedConfig = null;
			}
		} catch (err) {
			logger.warn("[config] Failed to load config.json, using defaults:", err);
			this.savedConfig = null;
		}
	}

	private writeToDisk(): boolean {
		const dir = dirname(this.configPath);
		mkdirSync(dir, { recursive: true });

		const data = this.savedConfig ? JSON.stringify(this.savedConfig, null, 2) : "{}";
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const tmpPath = `${this.configPath}.${suffix}.tmp`;

		try {
			writeFileSync(tmpPath, data);
			renameSync(tmpPath, this.configPath);
			return true;
		} catch (err) {
			logger.error(`[config] Failed to write config: ${err}`);
			try {
				unlinkSync(tmpPath);
			} catch {
				/* ignore */
			}
			return false;
		}
	}

	private validate(partial: DeepPartial<AppConfig>): ConfigValidationError[] {
		const errors: ConfigValidationError[] = [];

		const VALID_AUTO_MODES: AutoMode[] = ["manual", "normal", "full-auto"];
		if (partial.autoMode !== undefined && !VALID_AUTO_MODES.includes(partial.autoMode)) {
			errors.push({
				path: "autoMode",
				message: `Must be one of: ${VALID_AUTO_MODES.join(", ")}`,
				value: partial.autoMode,
			});
		}

		const OPTIONAL_MODEL_KEYS = new Set([
			"epicDecomposition",
			"mergeConflictResolution",
			"ciFix",
			"specify",
			"clarify",
			"plan",
			"tasks",
			"implement",
			"review",
			"implementReview",
			"commitPushPr",
		]);

		if (partial.models) {
			for (const [key, value] of Object.entries(partial.models)) {
				if (typeof value !== "string") {
					errors.push({
						path: `models.${key}`,
						message: "Must be a string",
						value,
					});
				} else if (value.trim() === "" && !OPTIONAL_MODEL_KEYS.has(key)) {
					errors.push({
						path: `models.${key}`,
						message: "Must be a non-empty string",
						value,
					});
				}
			}
		}

		const VALID_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "max"];

		if (partial.efforts) {
			for (const [key, value] of Object.entries(partial.efforts)) {
				if (!VALID_EFFORT_LEVELS.includes(value as EffortLevel)) {
					errors.push({
						path: `efforts.${key}`,
						message: `Must be one of: ${VALID_EFFORT_LEVELS.join(", ")}`,
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
			const meta = NUMERIC_SETTING_META.find((m) => m.key === `${sectionName}.${key}`);
			const minVal = meta ? meta.min : 1;

			if (typeof value !== "number" || !Number.isInteger(value) || value < minVal) {
				errors.push({
					path: `${sectionName}.${key}`,
					message: meta ? `Must be at least ${meta.min}` : "Must be a positive integer",
					value,
				});
			}
		}
	}

	private checkPromptVariables(partial: DeepPartial<AppConfig>): ConfigWarning[] {
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
