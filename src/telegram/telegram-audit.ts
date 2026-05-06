import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { auditDir } from "../litus-paths";
import { logger } from "../logger";
import type { AlertType } from "../types";

export type TelegramDeliveryAttempt =
	| {
			kind: "success";
			timestamp: string;
			alertId: string;
			alertType: AlertType;
			attempts: number;
	  }
	| {
			kind: "failure";
			timestamp: string;
			alertId: string;
			alertType: AlertType;
			attempts: number;
			reason: string;
			errorCode: number | null;
	  };

const FILE_NAME = "telegram-deliveries.jsonl";

export function appendTelegramDelivery(entry: TelegramDeliveryAttempt): void {
	try {
		const dir = auditDir();
		mkdirSync(dir, { recursive: true });
		const path = join(dir, FILE_NAME);
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	} catch (err) {
		logger.warn(`[telegram-audit] failed to append delivery entry: ${err}`);
	}
}
