import type { Page, WebSocket } from "@playwright/test";

/**
 * Observes WebSocket frames sent by the server to the browser so tests can
 * synchronise on specific broadcasts (`config:state`, `config:error`,
 * `purge:complete`, ...) rather than on fixed sleeps.
 *
 * Attach the observer BEFORE navigating to the page you want to observe. The
 * harness opens one WS per page; the observer listens for it and records
 * every inbound frame from that point on.
 */
export interface ServerMessage {
	type: string;
	[key: string]: unknown;
}

export class ServerMessageObserver {
	private readonly frames: ServerMessage[] = [];
	private readonly waiters: Array<{
		predicate: (m: ServerMessage) => boolean;
		resolve: (m: ServerMessage) => void;
	}> = [];

	constructor(page: Page) {
		page.on("websocket", (ws: WebSocket) => {
			ws.on("framereceived", (frame) => {
				let payload: ServerMessage;
				try {
					payload = JSON.parse(frame.payload as string) as ServerMessage;
				} catch {
					return;
				}
				this.frames.push(payload);
				for (let i = this.waiters.length - 1; i >= 0; i--) {
					const w = this.waiters[i];
					if (w.predicate(payload)) {
						this.waiters.splice(i, 1);
						w.resolve(payload);
					}
				}
			});
		});
	}

	/**
	 * Resolves with the next frame (received strictly after this call) that
	 * satisfies `predicate`. Rejects after `timeoutMs` if none arrives.
	 */
	waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs = 5_000): Promise<ServerMessage> {
		return new Promise((resolve, reject) => {
			const waiter = { predicate, resolve };
			this.waiters.push(waiter);
			const timer = setTimeout(() => {
				const idx = this.waiters.indexOf(waiter);
				if (idx >= 0) this.waiters.splice(idx, 1);
				reject(new Error(`Timed out after ${timeoutMs}ms waiting for server message`));
			}, timeoutMs);
			const origResolve = waiter.resolve;
			waiter.resolve = (m) => {
				clearTimeout(timer);
				origResolve(m);
			};
		});
	}

	/** True if any past frame matches the predicate (useful for post-hoc checks). */
	hasReceived(predicate: (m: ServerMessage) => boolean): boolean {
		return this.frames.some(predicate);
	}
}
