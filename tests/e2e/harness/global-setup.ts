import { chromium } from "@playwright/test";

/**
 * Fail fast with a clear message if the Chromium browser bundle has not been
 * installed. Using Playwright's own launcher (instead of probing
 * platform-specific cache paths) gives us a correct answer on every OS and
 * respects `PLAYWRIGHT_BROWSERS_PATH`.
 */
export default async function globalSetup() {
	try {
		const browser = await chromium.launch();
		await browser.close();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Chromium browser bundle not launchable. Run \`bunx playwright install --with-deps chromium\` before \`bun run test:e2e\`. Underlying error: ${msg}`,
		);
	}
}
