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
	  }
	| {
			kind: "forward-success";
			timestamp: string;
			questionId: string;
			workflowId: string;
			chunkCount: number;
	  }
	| {
			kind: "forward-failure";
			timestamp: string;
			questionId: string;
			workflowId: string;
			reason: string;
			errorCode: number | null;
	  }
	| {
			kind: "delete-success";
			timestamp: string;
			questionId: string;
			messageId: number;
	  }
	| {
			kind: "delete-failure";
			timestamp: string;
			questionId: string;
			messageId: number;
			attempts: number;
			reason: string;
			errorCode: number | null;
	  }
	| {
			kind: "inbound-callback";
			timestamp: string;
			questionId: string;
			callbackQueryId: string;
			data: string;
	  }
	| {
			kind: "inbound-message";
			timestamp: string;
			questionId: string;
			messageId: number;
			replyToMessageId: number;
	  }
	| {
			kind: "inbound-stale";
			timestamp: string;
			chatId: string;
			messageId: number | null;
			callbackQueryId: string | null;
			reason: "no-matching-question";
	  }
	| {
			kind: "inbound-unbound";
			timestamp: string;
			chatId: string;
			messageId: number;
			reason: "no-reply" | "reply-to-unrelated";
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
