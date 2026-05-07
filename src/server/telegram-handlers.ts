import type { ConfigStore } from "../config-store";
import { TELEGRAM_TOKEN_SENTINEL } from "../config-store";
import type { ClientMessage, ServerMessage } from "../protocol";
import type { TelegramFailureState } from "../telegram/telegram-failure-state";
import type { TelegramTransport } from "../telegram/telegram-transport";
import type { HandlerDeps, MessageHandler } from "./handler-types";

const TEST_MESSAGE_BODY =
	"<b>Litus test message</b>\nIf you see this, your bot token and chat are configured correctly.";

export interface TelegramHandlerDeps {
	failureState: TelegramFailureState;
	transport: TelegramTransport;
	configStore: ConfigStore;
	broadcast: (msg: ServerMessage) => void;
	sendTo: HandlerDeps["sendTo"];
}

/**
 * Module-level Telegram dependency container set by `server.ts` after
 * `TelegramNotifier` and friends are constructed. Keeping it module-scoped
 * means the same handler signatures used by `MessageRouter` work without
 * changing `HandlerDeps`.
 */
let telegramDeps: TelegramHandlerDeps | null = null;

export function setTelegramHandlerDeps(deps: TelegramHandlerDeps): void {
	telegramDeps = deps;
}

export function clearTelegramHandlerDeps(): void {
	telegramDeps = null;
}

export const handleTelegramTest: MessageHandler = async (ws, data, _deps) => {
	if (!telegramDeps) return;
	const msg = data as ClientMessage & { type: "telegram:test" };
	const stored = telegramDeps.configStore.get().telegram;

	const rawToken = msg.botToken === TELEGRAM_TOKEN_SENTINEL ? stored.botToken : msg.botToken;
	const botToken = (rawToken ?? "").trim();
	const chatId = (msg.chatId ?? "").trim();

	if (botToken === "" || chatId === "") {
		telegramDeps.sendTo(ws, {
			type: "telegram:test-result",
			ok: false,
			errorCode: null,
			reason: "Bot token and chat identifier are required.",
		});
		return;
	}

	const response = await telegramDeps.transport.send({
		botToken,
		chatId,
		text: TEST_MESSAGE_BODY,
		parseMode: "HTML",
	});

	if (response.kind === "ok") {
		telegramDeps.sendTo(ws, { type: "telegram:test-result", ok: true, errorCode: null, reason: "" });
		return;
	}

	const reason =
		response.httpStatus === null
			? response.description
			: `HTTP ${response.httpStatus}: ${response.description}`;
	telegramDeps.sendTo(ws, {
		type: "telegram:test-result",
		ok: false,
		errorCode: response.errorCode ?? response.httpStatus,
		reason,
	});
};

export const handleTelegramAcknowledge: MessageHandler = (_ws, _data, _deps) => {
	if (!telegramDeps) return;
	telegramDeps.failureState.acknowledge();
	telegramDeps.broadcast({
		type: "telegram:status",
		...telegramDeps.failureState.getStatus(),
	});
};

/** For tests/server bootstrap that need to send a status snapshot to a single
 *  socket (e.g. on connect). */
export function sendTelegramStatusTo(
	ws: Parameters<HandlerDeps["sendTo"]>[0],
	deps: { sendTo: HandlerDeps["sendTo"]; failureState: TelegramFailureState },
): void {
	deps.sendTo(ws, { type: "telegram:status", ...deps.failureState.getStatus() });
}
