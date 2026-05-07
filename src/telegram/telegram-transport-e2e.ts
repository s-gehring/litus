import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { logger } from "../logger";
import type {
	AnswerCallbackQueryRequest,
	DeleteMessageRequest,
	DeleteMessageResponse,
	GetUpdatesRequest,
	GetUpdatesResponse,
	PollerUpdate,
	TelegramRequest,
	TelegramSendResponse,
	TelegramTransport,
} from "./telegram-transport";

/**
 * E2E-only stub transport. Activated when both `LITUS_E2E_SCENARIO` AND
 * `LITUS_TELEGRAM_E2E_LOG` are set. Each call:
 *   1. Reads `LITUS_TELEGRAM_E2E_MODE` (default: "ok") to choose its response
 *   2. Appends one JSON line to the log file at `LITUS_TELEGRAM_E2E_LOG`
 *      so the Playwright test can assert the transport was called.
 *
 * Inbound updates (`getUpdates`) are read from a scripted-updates file at
 * `<log>.inbound`, one JSON-encoded `PollerUpdate` array per line, each line
 * consumed once. The poller calls `getUpdates` repeatedly; this stub returns
 * the next scripted batch on each call (or an empty batch when the queue is
 * empty).
 *
 * Returns null if the env gate is not satisfied — `server.ts` falls back to
 * the real `fetchTelegramTransport`. This module is a no-op in production.
 */
export function maybeBuildE2ETransport(): TelegramTransport | null {
	if (!process.env.LITUS_E2E_SCENARIO) return null;
	const logPathEnv = process.env.LITUS_TELEGRAM_E2E_LOG;
	if (!logPathEnv) return null;
	const logPath: string = logPathEnv;

	let nextMessageId = 1000;
	let nextInboundCursor = 0;

	function appendLog(entry: Record<string, unknown>): void {
		try {
			appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
		} catch (err) {
			logger.warn(`[telegram-e2e] failed to append log: ${err}`);
		}
	}

	return {
		async send(req: TelegramRequest): Promise<TelegramSendResponse> {
			const mode = readMode(logPath);
			const messageId = nextMessageId++;
			appendLog({
				call: "send",
				chatId: req.chatId,
				text: req.text,
				replyMarkup: req.replyMarkup ?? null,
				mode,
				messageId,
			});
			switch (mode) {
				case "fail-401":
					return {
						kind: "error",
						httpStatus: 401,
						errorCode: 401,
						description: "Unauthorized",
						retryAfterSeconds: null,
					};
				case "fail-network":
					return {
						kind: "error",
						httpStatus: null,
						errorCode: null,
						description: "network: stub-injected failure",
						retryAfterSeconds: null,
					};
				default:
					return { kind: "ok", messageId };
			}
		},

		async deleteMessage(req: DeleteMessageRequest): Promise<DeleteMessageResponse> {
			appendLog({ call: "deleteMessage", chatId: req.chatId, messageId: req.messageId });
			return { kind: "ok" };
		},

		async answerCallbackQuery(req: AnswerCallbackQueryRequest): Promise<DeleteMessageResponse> {
			appendLog({
				call: "answerCallbackQuery",
				callbackQueryId: req.callbackQueryId,
				text: req.text ?? null,
				showAlert: req.showAlert ?? null,
			});
			return { kind: "ok" };
		},

		async getUpdates(_req: GetUpdatesRequest, _signal: AbortSignal): Promise<GetUpdatesResponse> {
			const inboundPath = `${logPath}.inbound`;
			if (!existsSync(inboundPath)) {
				await sleepShort();
				return { kind: "ok", updates: [] };
			}
			let lines: string[];
			try {
				lines = readFileSync(inboundPath, "utf-8")
					.split("\n")
					.filter((l) => l.length > 0);
			} catch {
				await sleepShort();
				return { kind: "ok", updates: [] };
			}
			if (nextInboundCursor >= lines.length) {
				await sleepShort();
				return { kind: "ok", updates: [] };
			}
			const line = lines[nextInboundCursor];
			nextInboundCursor += 1;
			let updates: PollerUpdate[];
			try {
				updates = JSON.parse(line) as PollerUpdate[];
			} catch {
				updates = [];
			}
			appendLog({ call: "getUpdates", batchSize: updates.length });
			return { kind: "ok", updates };
		},
	};
}

function sleepShort(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * The mode is read fresh on every send so the test can flip it between
 * actions without restarting the server. The mode file lives next to
 * the call log.
 */
function readMode(logPath: string): "ok" | "fail-401" | "fail-network" {
	const modePath = `${logPath}.mode`;
	if (!existsSync(modePath)) return "ok";
	try {
		const v = readFileSync(modePath, "utf-8").trim();
		if (v === "fail-401" || v === "fail-network") return v;
	} catch {
		// Fall through to default.
	}
	return "ok";
}
