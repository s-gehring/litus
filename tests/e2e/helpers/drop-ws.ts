import type { ServerHandle } from "../harness/server";

export interface DropWebSocketOptions {
	server: ServerHandle;
}

/**
 * Closes the active server-side WebSocket(s) without killing the server
 * process. Tolerant: no-op when no socket is open, safe to call twice.
 * Requires the harness-spawned server to have LITUS_E2E_SCENARIO set (the
 * default for every test running under the E2E fixtures).
 */
export async function dropWebSocket(opts: DropWebSocketOptions): Promise<void> {
	await opts.server.dropActiveWebSockets();
}
