import type { AppPage } from "../pages/app";

/**
 * Navigate to `path` as a fresh page load (not a client-side `history.pushState`
 * transition). Caller passes `baseUrl` explicitly so the helper never depends
 * on the current `page.url()` — a fresh Playwright page is `about:blank`, and
 * resolving against that produces an unreachable `about:///...` URL.
 */
export async function deepLink(app: AppPage, baseUrl: string, path: string): Promise<void> {
	const target = new URL(path, baseUrl).toString();
	await app.page.goto(target);
	await app.waitConnected();
}
