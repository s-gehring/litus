import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, NUMERIC_SETTING_META, PROMPT_VARIABLES } from "../../src/config-store";
import type { AppConfig } from "../../src/types";

// ── T013: Config panel metadata consistency ───────────────────────────

describe("T013: NUMERIC_SETTING_META covers all limit and timing fields", () => {
	test("every LimitConfig key has a corresponding NUMERIC_SETTING_META entry", () => {
		const limitKeys = Object.keys(DEFAULT_CONFIG.limits);
		for (const key of limitKeys) {
			const meta = NUMERIC_SETTING_META.find((m) => m.key === `limits.${key}`);
			expect(meta).toBeDefined();
		}
	});

	test("every TimingConfig key has a corresponding NUMERIC_SETTING_META entry", () => {
		const timingKeys = Object.keys(DEFAULT_CONFIG.timing);
		for (const key of timingKeys) {
			const meta = NUMERIC_SETTING_META.find((m) => m.key === `timing.${key}`);
			expect(meta).toBeDefined();
		}
	});

	test("no NUMERIC_SETTING_META entry points to a nonexistent config key", () => {
		for (const meta of NUMERIC_SETTING_META) {
			const [section, key] = meta.key.split(".");
			const sectionObj = DEFAULT_CONFIG[section as keyof AppConfig] as unknown as Record<
				string,
				unknown
			>;
			expect(sectionObj).toBeDefined();
			expect(sectionObj[key]).toBeDefined();
		}
	});

	test("every NUMERIC_SETTING_META defaultValue matches DEFAULT_CONFIG", () => {
		for (const meta of NUMERIC_SETTING_META) {
			const [section, key] = meta.key.split(".");
			const sectionObj = DEFAULT_CONFIG[section as keyof AppConfig] as unknown as Record<
				string,
				number
			>;
			expect(sectionObj[key]).toBe(meta.defaultValue);
		}
	});

	test("every NUMERIC_SETTING_META min is positive", () => {
		for (const meta of NUMERIC_SETTING_META) {
			expect(meta.min).toBeGreaterThan(0);
		}
	});
});

// ── T024: Config panel models section data ────────────────────────────

describe("T024: ModelConfig fields are all non-empty strings in defaults", () => {
	test("all 4 model fields have non-empty default values", () => {
		const modelKeys = Object.keys(DEFAULT_CONFIG.models) as (keyof AppConfig["models"])[];
		expect(modelKeys).toHaveLength(4);
		for (const key of modelKeys) {
			expect(typeof DEFAULT_CONFIG.models[key]).toBe("string");
			expect(DEFAULT_CONFIG.models[key].length).toBeGreaterThan(0);
		}
	});
});

// ── T030: Config panel prompts section data ───────────────────────────

describe("T030: PROMPT_VARIABLES covers all PromptConfig keys", () => {
	test("every PromptConfig key has a PROMPT_VARIABLES entry", () => {
		const promptKeys = Object.keys(DEFAULT_CONFIG.prompts);
		for (const key of promptKeys) {
			const vars = PROMPT_VARIABLES[key as keyof typeof PROMPT_VARIABLES];
			expect(vars).toBeDefined();
			expect(vars.length).toBeGreaterThan(0);
		}
	});

	test("no PROMPT_VARIABLES entry points to a nonexistent PromptConfig key", () => {
		for (const key of Object.keys(PROMPT_VARIABLES)) {
			expect(DEFAULT_CONFIG.prompts).toHaveProperty(key);
		}
	});

	test("every default prompt contains its declared template variables", () => {
		for (const [key, vars] of Object.entries(PROMPT_VARIABLES)) {
			const prompt = DEFAULT_CONFIG.prompts[key as keyof AppConfig["prompts"]];
			for (const v of vars) {
				expect(prompt).toContain(`\${${v.name}}`);
			}
		}
	});

	test("all 6 prompt fields have non-empty default values", () => {
		const promptKeys = Object.keys(DEFAULT_CONFIG.prompts) as (keyof AppConfig["prompts"])[];
		expect(promptKeys).toHaveLength(6);
		for (const key of promptKeys) {
			expect(typeof DEFAULT_CONFIG.prompts[key]).toBe("string");
			expect(DEFAULT_CONFIG.prompts[key].length).toBeGreaterThan(0);
		}
	});
});

describe("T030: template variable substitution with replaceAll", () => {
	test("replaceAll handles duplicate variable references in a prompt", () => {
		const customPrompt = "First: ${text}, Second: ${text}";
		const result = customPrompt.replaceAll("${text}", "hello world");
		expect(result).toBe("First: hello world, Second: hello world");
		expect(result).not.toContain("${text}");
	});
});
