import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, DEFAULT_CONFIG } from "../src/config-store";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "config-store-test-"));
}

function configPath(dir: string): string {
	return join(dir, "config.json");
}

// ── T003: Config store basics ──────────────────────────────────────────────

describe("T003: load defaults when no file exists", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("get() returns DEFAULT_CONFIG when config file does not exist", () => {
		const store = new ConfigStore(join(dir, "nonexistent", "config.json"));
		expect(store.get()).toEqual(DEFAULT_CONFIG);
	});
});

describe("T003: load saved values", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("get() returns saved values when config file exists", () => {
		const saved = {
			limits: { ciFixMaxAttempts: 7, reviewCycleMaxIterations: 16, mergeMaxAttempts: 3 },
		};
		writeFileSync(configPath(dir), JSON.stringify(saved));

		const store = new ConfigStore(configPath(dir));
		expect(store.get().limits.ciFixMaxAttempts).toBe(7);
	});
});

describe("T003: shallow merge per section", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("saved section with only some keys — missing keys fall back to defaults", () => {
		// Only save ciFixMaxAttempts; reviewCycleMaxIterations and mergeMaxAttempts should come from defaults
		const saved = { limits: { ciFixMaxAttempts: 5 } };
		writeFileSync(configPath(dir), JSON.stringify(saved));

		const store = new ConfigStore(configPath(dir));
		const config = store.get();

		expect(config.limits.ciFixMaxAttempts).toBe(5);
		expect(config.limits.reviewCycleMaxIterations).toBe(
			DEFAULT_CONFIG.limits.reviewCycleMaxIterations,
		);
		expect(config.limits.mergeMaxAttempts).toBe(DEFAULT_CONFIG.limits.mergeMaxAttempts);
	});
});

describe("T003: missing keys fallback for partial sections", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("saved config with only limits — models, prompts, timing all come from defaults", () => {
		const saved = {
			limits: { ciFixMaxAttempts: 2, reviewCycleMaxIterations: 8, mergeMaxAttempts: 2 },
		};
		writeFileSync(configPath(dir), JSON.stringify(saved));

		const store = new ConfigStore(configPath(dir));
		const config = store.get();

		expect(config.models).toEqual(DEFAULT_CONFIG.models);
		expect(config.prompts).toEqual(DEFAULT_CONFIG.prompts);
		expect(config.timing).toEqual(DEFAULT_CONFIG.timing);
	});
});

describe("T003: invalid JSON fallback", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("get() returns DEFAULT_CONFIG when config file contains invalid JSON", () => {
		writeFileSync(configPath(dir), "{ this is not valid json !!!");

		const store = new ConfigStore(configPath(dir));
		expect(store.get()).toEqual(DEFAULT_CONFIG);
	});
});

describe("T003: atomic write", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("save() writes a valid JSON file to disk", () => {
		const store = new ConfigStore(configPath(dir));
		const { errors } = store.save({
			limits: { ciFixMaxAttempts: 4, reviewCycleMaxIterations: 16, mergeMaxAttempts: 3 },
		});

		expect(errors).toHaveLength(0);

		const text = require("node:fs").readFileSync(configPath(dir), "utf-8");
		const parsed = JSON.parse(text);
		expect(parsed.limits.ciFixMaxAttempts).toBe(4);
	});
});

describe("T003: reset single key", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("reset('limits.ciFixMaxAttempts') reverts that key to default", () => {
		const store = new ConfigStore(configPath(dir));
		store.save({
			limits: { ciFixMaxAttempts: 9, reviewCycleMaxIterations: 16, mergeMaxAttempts: 3 },
		});

		expect(store.get().limits.ciFixMaxAttempts).toBe(9);

		store.reset("limits.ciFixMaxAttempts");

		expect(store.get().limits.ciFixMaxAttempts).toBe(DEFAULT_CONFIG.limits.ciFixMaxAttempts);
		// Other keys in the section should be unaffected
		expect(store.get().limits.reviewCycleMaxIterations).toBe(16);
	});
});

describe("T003: reset whole section", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("reset('limits') reverts all limits keys to defaults", () => {
		const store = new ConfigStore(configPath(dir));
		store.save({
			limits: { ciFixMaxAttempts: 9, reviewCycleMaxIterations: 10, mergeMaxAttempts: 5 },
		});

		store.reset("limits");

		expect(store.get().limits).toEqual(DEFAULT_CONFIG.limits);
	});
});

describe("T003: reset all", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("reset() with no argument reverts the entire config to defaults", () => {
		const store = new ConfigStore(configPath(dir));
		store.save({
			limits: { ciFixMaxAttempts: 9, reviewCycleMaxIterations: 10, mergeMaxAttempts: 5 },
			models: {
				questionDetection: "custom-model",
				reviewClassification: "claude-haiku-4-5-20251001",
				activitySummarization: "claude-haiku-4-5-20251001",
				specSummarization: "claude-haiku-4-5-20251001",
			},
		});

		store.reset();

		expect(store.get()).toEqual(DEFAULT_CONFIG);
	});
});

// ── T005: Validation ───────────────────────────────────────────────────────

describe("T005: positive integer check", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("save with limits.ciFixMaxAttempts = -1 returns an error", () => {
		const store = new ConfigStore(configPath(dir));
		const { errors } = store.save({
			limits: { ciFixMaxAttempts: -1, reviewCycleMaxIterations: 16, mergeMaxAttempts: 3 },
		});

		expect(errors.length).toBeGreaterThan(0);
		const err = errors.find((e) => e.path === "limits.ciFixMaxAttempts");
		expect(err).toBeDefined();
	});
});

describe("T005: min bound enforcement", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("save with timing.ciPollIntervalMs = 100 returns an error (min is 5000)", () => {
		const store = new ConfigStore(configPath(dir));
		const { errors } = store.save({
			timing: {
				ciPollIntervalMs: 100,
				ciGlobalTimeoutMs: DEFAULT_CONFIG.timing.ciGlobalTimeoutMs,
				questionDetectionCooldownMs: DEFAULT_CONFIG.timing.questionDetectionCooldownMs,
				activitySummaryIntervalMs: DEFAULT_CONFIG.timing.activitySummaryIntervalMs,
				rateLimitBackoffMs: DEFAULT_CONFIG.timing.rateLimitBackoffMs,
				maxCiLogLength: DEFAULT_CONFIG.timing.maxCiLogLength,
				maxClientOutputLines: DEFAULT_CONFIG.timing.maxClientOutputLines,
			},
		});

		expect(errors.length).toBeGreaterThan(0);
		const err = errors.find((e) => e.path === "timing.ciPollIntervalMs");
		expect(err).toBeDefined();
		expect(err?.message).toMatch(/5000/);
	});
});

describe("T005: non-empty string check", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("save with models.questionDetection = '' returns an error", () => {
		const store = new ConfigStore(configPath(dir));
		const { errors } = store.save({
			models: {
				questionDetection: "",
				reviewClassification: "claude-haiku-4-5-20251001",
				activitySummarization: "claude-haiku-4-5-20251001",
				specSummarization: "claude-haiku-4-5-20251001",
			},
		});

		expect(errors.length).toBeGreaterThan(0);
		const err = errors.find((e) => e.path === "models.questionDetection");
		expect(err).toBeDefined();
	});
});

describe("T005: partial save validation — no write on error", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("save with one valid and one invalid field returns error and does not write", () => {
		const store = new ConfigStore(configPath(dir));

		// Save valid data first so we have a baseline on disk
		store.save({
			limits: { ciFixMaxAttempts: 3, reviewCycleMaxIterations: 16, mergeMaxAttempts: 3 },
		});

		// Now attempt a partial save with an invalid field mixed in
		const { errors } = store.save({
			limits: {
				ciFixMaxAttempts: -99, // invalid
				reviewCycleMaxIterations: 16,
				mergeMaxAttempts: 3,
			},
		});

		expect(errors.length).toBeGreaterThan(0);
		// The valid previously-saved value must be untouched
		expect(store.get().limits.ciFixMaxAttempts).toBe(3);
	});
});

describe("T005: template variable warning generation", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("save a prompt missing required template variable returns a warning but succeeds", () => {
		const store = new ConfigStore(configPath(dir));

		// questionDetection requires ${text} — omit it to trigger a warning
		const { errors, warnings } = store.save({
			prompts: {
				...DEFAULT_CONFIG.prompts,
				questionDetection: "Is this a question? Answer yes or no.",
			},
		});

		expect(errors).toHaveLength(0);
		expect(warnings.length).toBeGreaterThan(0);

		const warning = warnings.find((w) => w.path === "prompts.questionDetection");
		expect(warning).toBeDefined();
		expect(warning?.missingVariables).toContain("text");

		// The save must still have persisted the new prompt
		expect(store.get().prompts.questionDetection).toBe("Is this a question? Answer yes or no.");
	});
});
