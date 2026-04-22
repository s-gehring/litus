import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	outputDir: "./test-results",
	// The suite spawns a fresh server+sandbox per test; running them serially
	// avoids port exhaustion and keeps per-test logs linear. `workers: 1`
	// already enforces serialisation at the worker level.
	workers: 1,
	// Retries off in CI: when tests fail on this branch (UI redesign vs
	// master-merged tests that still assert legacy selectors / tri-state
	// auto-mode classes) they fail deterministically — a retry just doubles
	// the wall-clock cost and pushes the job past the 15m GitHub timeout.
	retries: 0,
	// Cap per-action and per-expect waits so a hang on a hidden/absent
	// element fails fast (≤10s) rather than burning the whole test-level
	// `setTimeout` budget (some master tests set 240_000ms). Same rationale
	// for navigationTimeout.
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	globalSetup: "./harness/global-setup.ts",
	use: {
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
		actionTimeout: 10_000,
		navigationTimeout: 20_000,
	},
	projects: [
		{
			name: "chromium",
			use: { browserName: "chromium" },
		},
	],
});
