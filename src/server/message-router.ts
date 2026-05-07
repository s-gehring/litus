import { clientMessageSchema } from "@litus/protocol";
import type { ServerWebSocket } from "bun";
import { toErrorMessage } from "../errors";
import { logger } from "../logger";
import type { HandlerDeps, MessageHandler, WsData } from "./handler-types";
import { logProtocolFailure } from "./protocol-logging";

export class MessageRouter {
	private handlers = new Map<string, MessageHandler>();

	register(type: string, handler: MessageHandler): void {
		this.handlers.set(type, handler);
	}

	dispatch(ws: ServerWebSocket<WsData>, raw: string | Buffer, deps: HandlerDeps): void {
		const size = typeof raw === "string" ? raw.length : raw.byteLength;
		if (size > 1_000_000) {
			logProtocolFailure({
				code: "message_too_large",
				socketId: ws.data?.socketId,
				details: { size, limit: 1_000_000 },
			});
			deps.sendTo(ws, {
				type: "error",
				code: "message_too_large",
				message: "Message too large (max 1 MB)",
				details: { size, limit: 1_000_000 },
			});
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(String(raw));
		} catch {
			logProtocolFailure({
				code: "schema_violation",
				socketId: ws.data?.socketId,
			});
			deps.sendTo(ws, {
				type: "error",
				code: "schema_violation",
				message: "Invalid message format (not JSON)",
			});
			return;
		}

		const result = clientMessageSchema.safeParse(parsed);
		if (!result.success) {
			const originalType =
				typeof parsed === "object" && parsed !== null && "type" in parsed
					? String((parsed as { type: unknown }).type)
					: undefined;
			logProtocolFailure({
				code: "schema_violation",
				socketId: ws.data?.socketId,
				originalType,
				issues: result.error.issues,
			});
			deps.sendTo(ws, {
				type: "error",
				code: "schema_violation",
				message:
					originalType !== undefined
						? `Schema violation for type "${originalType}"`
						: "Schema violation: invalid message",
				details: { issues: result.error.issues },
			});
			return;
		}

		const msg = result.data;
		const handler = this.handlers.get(msg.type);
		if (!handler) {
			// Unreachable in practice because clientMessageSchema rejects
			// unknown `type` values via z.discriminatedUnion. Kept as a
			// defensive guard if a handler is removed without removing
			// the schema variant.
			logProtocolFailure({
				code: "internal",
				socketId: ws.data?.socketId,
				originalType: msg.type,
			});
			deps.sendTo(ws, {
				type: "error",
				code: "internal",
				message: `No handler registered for type: ${msg.type}`,
			});
			return;
		}

		try {
			const handlerResult = handler(ws, msg as Parameters<MessageHandler>[1], deps);
			if (handlerResult instanceof Promise) {
				handlerResult.catch((err) => {
					logger.error("[ws] Async message handling error:", err);
					const text = toErrorMessage(err);
					deps.sendTo(ws, { type: "error", code: "internal", message: text });
				});
			}
		} catch (err) {
			logger.error("[ws] Message handling error:", err);
			const text = toErrorMessage(err);
			deps.sendTo(ws, { type: "error", code: "internal", message: text });
		}
	}
}
