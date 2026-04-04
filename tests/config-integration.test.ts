import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, DEFAULT_CONFIG } from "../src/config-store";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "config-integration-test-"));
}

function configPath(dir: string): string {
	return join(dir, "config.json");
}

// ── T004: Integration tests ────────────────────────────────────────────────

describe("T004: save then load roundtrip", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("save partial config → new ConfigStore with same path → values match", () => {
		const path = configPath(dir);
		const first = new ConfigStore(path);

		const { errors } = first.save({
			limits: { ciFixMaxAttempts: 6, reviewCycleMaxIterations: 12, mergeMaxAttempts: 2 },
		});
		expect(errors).toHaveLength(0);

		const second = new ConfigStore(path);
		const config = second.get();

		expect(config.limits.ciFixMaxAttempts).toBe(6);
		expect(config.limits.reviewCycleMaxIterations).toBe(12);
		expect(config.limits.mergeMaxAttempts).toBe(2);
	});
});

describe("T004: survive simulated restart", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("save → new ConfigStore instance → get() returns the saved values", () => {
		const path = configPath(dir);

		const original = new ConfigStore(path);
		original.save({
			models: {
				questionDetection: "my-custom-model",
				reviewClassification: "claude-haiku-4-5-20251001",
				activitySummarization: "claude-haiku-4-5-20251001",
				specSummarization: "claude-haiku-4-5-20251001",
			},
			timing: {
				ciPollIntervalMs: 30_000,
				ciGlobalTimeoutMs: DEFAULT_CONFIG.timing.ciGlobalTimeoutMs,
				questionDetectionCooldownMs: DEFAULT_CONFIG.timing.questionDetectionCooldownMs,
				activitySummaryIntervalMs: DEFAULT_CONFIG.timing.activitySummaryIntervalMs,
				rateLimitBackoffMs: DEFAULT_CONFIG.timing.rateLimitBackoffMs,
				maxCiLogLength: DEFAULT_CONFIG.timing.maxCiLogLength,
				maxClientOutputLines: DEFAULT_CONFIG.timing.maxClientOutputLines,
			},
		});

		// Simulate a server restart by constructing a fresh instance
		const restarted = new ConfigStore(path);
		const config = restarted.get();

		expect(config.models.questionDetection).toBe("my-custom-model");
		expect(config.timing.ciPollIntervalMs).toBe(30_000);
	});
});

describe("T004: corrupt file recovery", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("corrupt JSON file → new ConfigStore → get() returns defaults", () => {
		const path = configPath(dir);
		writeFileSync(path, "not-valid-json{{{{");

		const store = new ConfigStore(path);
		expect(store.get()).toEqual(DEFAULT_CONFIG);
	});
});

describe("T004: new defaults merge with old saved file", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("file with only limits → new instance → models/prompts/timing have defaults", () => {
		const path = configPath(dir);

		// Write a config file that only has the limits section
		writeFileSync(
			path,
			JSON.stringify({
				limits: { ciFixMaxAttempts: 5, reviewCycleMaxIterations: 8, mergeMaxAttempts: 2 },
			}),
		);

		const store = new ConfigStore(path);
		const config = store.get();

		// The saved limits section should be loaded
		expect(config.limits.ciFixMaxAttempts).toBe(5);
		expect(config.limits.reviewCycleMaxIterations).toBe(8);
		expect(config.limits.mergeMaxAttempts).toBe(2);

		// All other sections must come from defaults
		expect(config.models).toEqual(DEFAULT_CONFIG.models);
		expect(config.prompts).toEqual(DEFAULT_CONFIG.prompts);
		expect(config.timing).toEqual(DEFAULT_CONFIG.timing);
	});
});
