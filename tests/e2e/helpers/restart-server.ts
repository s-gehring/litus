import type { Page } from "@playwright/test";
import type { Sandbox } from "../harness/sandbox";
import type { ServerHandle } from "../harness/server";

export interface RestartServerOptions {
	server: ServerHandle;
	sandbox: Sandbox;
	page: Page;
}

/**
 * Intent-layer wrapper over `ServerHandle.restart()`. Stops the running
 * server, respawns it against the same `homeDir`/`scenarioPath`/counters,
 * and reloads the page against the fresh `baseUrl`. Persisted state under
 * `$HOME/.litus/` survives.
 */
export async function restartServer(opts: RestartServerOptions): Promise<void> {
	const { server, page } = opts;
	await server.restart();
	await page.goto(server.baseUrl);
}
