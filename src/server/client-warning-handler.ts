import { logger } from "../logger";
import type { MessageHandler } from "./handler-types";

/**
 * Handles `client:warning` messages from the browser. The client sends these
 * when a slice reducer encounters an unknown id. Server logs the warning and
 * never broadcasts it back — diagnostic only.
 */
export const handleClientWarning: MessageHandler = (_ws, data, _deps) => {
	if (data.type !== "client:warning") return;
	logger.warn(`[client:${data.source}] ${data.message}`);
};
