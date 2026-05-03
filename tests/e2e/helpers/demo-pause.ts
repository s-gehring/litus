import type { Page } from "@playwright/test";

/**
 * Insert a viewer-friendly pause when recording demo videos. Reads
 * `LITUS_E2E_DEMO_DELAY_MS` from the environment — when unset (the default,
 * including all CI runs), this is a no-op and tests run at full speed. When
 * set to a positive integer, calling `demoPause(page)` waits that many
 * milliseconds so the recorded video has enough dwell time on each user
 * action for a viewer to follow what happened.
 *
 * Pair with the same env var passed through to `tests/e2e/fakes/claude.ts`,
 * which adds a matching delay between every emitted event so step
 * transitions also slow down.
 */
const DEMO_DELAY_MS = Number(process.env.LITUS_E2E_DEMO_DELAY_MS) || 0;

export const isDemoRecording = DEMO_DELAY_MS > 0;

export async function demoPause(page: Page, ms?: number): Promise<void> {
	if (DEMO_DELAY_MS <= 0) return;
	await page.waitForTimeout(ms ?? DEMO_DELAY_MS);
}
