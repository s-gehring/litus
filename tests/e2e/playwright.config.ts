import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: "**/*.e2e.ts",
	outputDir: "./test-results",
	// The suite spawns a fresh server+sandbox per test; running them serially
	// avoids port exhaustion and keeps per-test logs linear. `workers: 1`
	// already enforces serialisation at the worker level.
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	globalSetup: "./harness/global-setup.ts",
	use: {
		trace: process.env.CI ? "retain-on-failure" : "on",
		screenshot: process.env.CI ? "only-on-failure" : "on",
		video: process.env.CI ? "retain-on-failure" : "on",
	},
	projects: [
		{
			name: "chromium",
			use: { browserName: "chromium" },
		},
	],
});
