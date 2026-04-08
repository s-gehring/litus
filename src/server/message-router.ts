import type { ServerWebSocket } from "bun";
import type { HandlerDeps, MessageHandler, WsData } from "./handler-types";

export class MessageRouter {
	private handlers = new Map<string, MessageHandler>();

	register(type: string, handler: MessageHandler): void {
		this.handlers.set(type, handler);
	}

	dispatch(ws: ServerWebSocket<WsData>, raw: string | Buffer, deps: HandlerDeps): void {
		const size = typeof raw === "string" ? raw.length : raw.byteLength;
		if (size > 1_000_000) {
			deps.sendTo(ws, { type: "error", message: "Message too large (max 1 MB)" });
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(String(raw));
		} catch {
			deps.sendTo(ws, { type: "error", message: "Invalid message format" });
			return;
		}

		const msg = parsed as { type?: string };
		if (!msg || typeof msg.type !== "string") {
			deps.sendTo(ws, { type: "error", message: "Invalid message format" });
			return;
		}

		const handler = this.handlers.get(msg.type);
		if (!handler) {
			deps.sendTo(ws, {
				type: "error",
				message: `Unknown message type: ${msg.type}`,
			});
			return;
		}

		try {
			const result = handler(ws, parsed as Parameters<MessageHandler>[1], deps);
			if (result instanceof Promise) {
				result.catch((err) => {
					console.error("[ws] Async message handling error:", err);
					const text = err instanceof Error ? err.message : "Internal error";
					deps.sendTo(ws, { type: "error", message: text });
				});
			}
		} catch (err) {
			console.error("[ws] Message handling error:", err);
			const text = err instanceof Error ? err.message : "Internal error";
			deps.sendTo(ws, { type: "error", message: text });
		}
	}
}
