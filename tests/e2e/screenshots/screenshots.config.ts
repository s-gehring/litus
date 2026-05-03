import { defineConfig } from "@playwright/test";

// Standalone Playwright config for the README screenshot harness. Lives next
// to the e2e config but matches a different file pattern (`*.shots.ts`) so
// the e2e suite never runs these and they never run in CI. Invoked via
// `bun run capture:screenshots`. Outputs land in `docs/screenshots/`.
//
// Reuses `tests/e2e/harness/global-setup.ts` for the Chromium-installed
// pre-flight check and the same fixtures (sandbox, scenario-driven server)
// as the e2e suite — see `tests/e2e/harness/fixtures.ts`.
//
// Default-on demo delay: every fake-claude event holds for this many ms after
// emit, so the running state of each step is long enough to (a) render in
// the DOM and (b) survive Playwright's locator polling cadence. Without
// this, fast steps like `review` complete between polls and their assistant
// text never makes it into a screenshot.
process.env.LITUS_E2E_DEMO_DELAY_MS ??= "1500";

export default defineConfig({
	testDir: "./",
	testMatch: "**/*.shots.ts",
	outputDir: "./output",
	workers: 1,
	retries: 0,
	reporter: "list",
	globalSetup: "../harness/global-setup.ts",
	use: {
		// Fixed viewport keeps the saved PNGs reproducible across runs and
		// avoids the README rendering the screenshots at wildly different
		// aspect ratios depending on the developer's monitor.
		viewport: { width: 1400, height: 900 },
		trace: "off",
		screenshot: "off",
		video: "off",
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
