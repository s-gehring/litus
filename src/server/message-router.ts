import { CLOSE_CODE_PROTOCOL, clientMessageSchema, PROTOCOL_VERSION } from "@litus/protocol";
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

		// FR-010..FR-014, R-3: enforce the version handshake on the
		// first inbound frame. After `helloReceived = true`, dispatch
		// proceeds normally; a duplicate `client:hello` is accepted as
		// a no-op.
		if (!ws.data?.helloReceived) {
			if (msg.type !== "client:hello") {
				logProtocolFailure({
					code: "missing_protocol_version",
					socketId: ws.data?.socketId,
					originalType: msg.type,
				});
				deps.sendTo(ws, {
					type: "error",
					code: "missing_protocol_version",
					message: "Expected `client:hello` as the first frame",
				});
				ws.close(CLOSE_CODE_PROTOCOL);
				return;
			}
			if (msg.protocolVersion.major !== PROTOCOL_VERSION.major) {
				logProtocolFailure({
					code: "version_mismatch",
					socketId: ws.data?.socketId,
					details: {
						observed: msg.protocolVersion,
						expected: PROTOCOL_VERSION,
					},
				});
				deps.sendTo(ws, {
					type: "error",
					code: "version_mismatch",
					message: `Protocol version mismatch (server major=${PROTOCOL_VERSION.major}, client major=${msg.protocolVersion.major})`,
					details: {
						observed: msg.protocolVersion,
						expected: PROTOCOL_VERSION,
					},
				});
				ws.close(CLOSE_CODE_PROTOCOL);
				return;
			}
			if (ws.data) {
				ws.data.helloReceived = true;
			}
			return;
		}

		// Steady state: duplicate hello is a no-op.
		if (msg.type === "client:hello") {
			return;
		}

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
