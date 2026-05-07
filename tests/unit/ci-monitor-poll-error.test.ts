// Drives the real `startMonitoring` from `src/ci-monitor.ts` to assert the
// catch-block path does NOT call `onPollComplete` (contract O-2). Backs
// review item #9 — the previous test was a positive-path mock and would not
// catch a regression that added `onPollComplete?.()` into the catch block.

import { describe, expect, mock, test } from "bun:test";

type GitSpawnAction =
	| { code: number; stdout: string; stderr: string }
	| { throws: true; message: string };

const gitSpawnQueue: GitSpawnAction[] = [];

mock.module("../../src/git-logger", () => ({
	setGitLogCallback: () => {},
	gitSpawn: async (args: string[]) => {
		// `checkGhAuth` (`gh auth status`) — always succeed.
		if (args[0] === "gh" && args[1] === "auth") {
			return { code: 0, stdout: "", stderr: "" };
		}
		const next = gitSpawnQueue.shift();
		if (!next) return { code: 0, stdout: "[]", stderr: "" };
		if ("throws" in next) throw new Error(next.message);
		return next;
	},
}));

// `mock.module` is process-wide in bun, so this mock can leak into sibling
// tests that read other prompts via configStore. Populate prompts.* with
// non-empty placeholders so consumers like buildFixPrompt don't crash on
// `undefined.replaceAll`. Re-export the real DEFAULT_CONFIG and provide
// no-op save/reset so sibling tests using configStore.save() don't crash.
import { DEFAULT_CONFIG as REAL_DEFAULT_CONFIG } from "../../src/config-store";

mock.module("../../src/config-store", () => {
	const config = {
		models: {},
		efforts: {},
		prompts: {
			ciFixInstruction: "PR ${prUrl}\n${logSections}",
		},
		limits: { ciFixMaxAttempts: 3, mergeMaxAttempts: 3, reviewCycleMaxIterations: 3 },
		timing: { ciPollIntervalMs: 1, ciGlobalTimeoutMs: 60_000, rateLimitBackoffMs: 1 },
		autoMode: "normal",
		telegram: {},
	};
	return {
		configStore: {
			get: () => config,
			save: (partial: Record<string, unknown>) => {
				for (const [k, v] of Object.entries(partial)) {
					if (v !== null && typeof v === "object" && !Array.isArray(v)) {
						(config as Record<string, unknown>)[k] = {
							...((config as Record<string, unknown>)[k] as Record<string, unknown>),
							...(v as Record<string, unknown>),
						};
					} else {
						(config as Record<string, unknown>)[k] = v;
					}
				}
				return { errors: [], warnings: [] };
			},
			reset: () => {},
		},
		DEFAULT_CONFIG: REAL_DEFAULT_CONFIG,
	};
});

import { startMonitoring } from "../../src/ci-monitor";
import type { CiCycle } from "../../src/types";

function makeCycle(): CiCycle {
	return {
		attempt: 0,
		maxAttempts: 3,
		monitorStartedAt: new Date().toISOString(),
		globalTimeoutMs: 60_000,
		lastCheckResults: [],
		pollCount: 0,
		failureLogs: [],
	};
}

describe("ci-monitor.startMonitoring poll-error path (review #9 / contract O-2)", () => {
	test("a thrown poll does NOT invoke onPollComplete; the next successful poll does", async () => {
		gitSpawnQueue.length = 0;
		// First `gh pr checks` throws; second succeeds with a passing check.
		gitSpawnQueue.push({ throws: true, message: "transient network blip" });
		gitSpawnQueue.push({
			code: 0,
			stdout: JSON.stringify([{ name: "build", state: "success", bucket: "pass", link: "" }]),
			stderr: "",
		});

		const cycle = makeCycle();
		let pollCompleteCount = 0;
		const result = await startMonitoring(
			"https://github.com/owner/repo/pull/1",
			cycle,
			() => {},
			undefined,
			() => {
				pollCompleteCount++;
			},
		);

		expect(result.passed).toBe(true);
		// Only the successful poll triggered onPollComplete; the catch block did not.
		expect(pollCompleteCount).toBe(1);
		expect(cycle.pollCount).toBe(1);
	});
});
