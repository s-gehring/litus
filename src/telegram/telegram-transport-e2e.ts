import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { logger } from "../logger";
import type { TelegramRequest, TelegramResponse, TelegramTransport } from "./telegram-transport";

/**
 * E2E-only stub transport. Activated when both `LITUS_E2E_SCENARIO` AND
 * `LITUS_TELEGRAM_E2E_LOG` are set. Each `send()` call:
 *   1. Reads `LITUS_TELEGRAM_E2E_MODE` (default: "ok") to choose its response
 *   2. Appends one JSON line `{ chatId, text, mode }` to the log file at
 *      `LITUS_TELEGRAM_E2E_LOG` so the Playwright test can assert the
 *      transport was called with the right payload.
 *
 * Returns null if the env gate is not satisfied — `server.ts` falls back to
 * the real `fetchTelegramTransport`. This module is a no-op in production.
 */
export function maybeBuildE2ETransport(): TelegramTransport | null {
	if (!process.env.LITUS_E2E_SCENARIO) return null;
	const logPath = process.env.LITUS_TELEGRAM_E2E_LOG;
	if (!logPath) return null;

	return {
		async send(req: TelegramRequest): Promise<TelegramResponse> {
			const mode = readMode(logPath);
			try {
				appendFileSync(
					logPath,
					`${JSON.stringify({ chatId: req.chatId, text: req.text, mode })}\n`,
				);
			} catch (err) {
				logger.warn(`[telegram-e2e] failed to append log: ${err}`);
			}
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
					return { kind: "ok" };
			}
		},
	};
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
