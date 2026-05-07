import type { TelegramSettings } from "../config-types";
import { logger } from "../logger";
import type { Question } from "../types";
import { appendTelegramDelivery } from "./telegram-audit";
import type { TelegramFailureState } from "./telegram-failure-state";
import { categorizeRetry, describeFailure } from "./telegram-notifier";
import { formatQuestionForTelegram } from "./telegram-question-formatter";
import { parseOptionsFromQuestion } from "./telegram-question-options";
import type { ForwardedQuestion, TelegramQuestionStore } from "./telegram-question-store";
import type {
	DeleteMessageResponse,
	TelegramSendResponse,
	TelegramTransport,
} from "./telegram-transport";

const DELETE_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const STALE_REPLY_TEXT = "This question has already been answered.";
const UNBOUND_REPLY_TEXT =
	"Please reply to a forwarded question's message to answer it. Plain messages are not bound to a specific question.";

export type AnswerQuestionFn = (workflowId: string, questionId: string, answer: string) => void;

export interface TelegramQuestionForwarderOptions {
	transport: TelegramTransport;
	store: TelegramQuestionStore;
	getSettings: () => TelegramSettings;
	failureState: TelegramFailureState;
	answerQuestion: AnswerQuestionFn;
	sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramQuestionForwarder {
	private readonly opts: Required<TelegramQuestionForwarderOptions>;

	constructor(options: TelegramQuestionForwarderOptions) {
		this.opts = {
			sleep: options.sleep ?? defaultSleep,
			...options,
		};
	}

	private shouldForward(): { token: string; chatId: string } | null {
		const settings = this.opts.getSettings();
		if (!settings.active || !settings.forwardQuestions) return null;
		const token = settings.botToken.trim();
		const chatId = settings.chatId.trim();
		if (token === "" || chatId === "") return null;
		return { token, chatId };
	}

	/** Hook for `onQuestionForward`. Best-effort; never throws. */
	async forwardQuestion(workflowId: string, question: Question): Promise<void> {
		try {
			await this.forwardQuestionInner(workflowId, question);
		} catch (err) {
			logger.warn(`[telegram-forwarder] forwardQuestion threw: ${err}`);
		}
	}

	private async forwardQuestionInner(workflowId: string, question: Question): Promise<void> {
		const creds = this.shouldForward();
		if (!creds) return;
		// FR-013 hardening: empty content would land in Telegram as a 400
		// Bad Request on sendMessage; skip up front so the audit log isn't
		// polluted with avoidable forward-failure entries.
		if (question.content.trim() === "") return;

		const options = parseOptionsFromQuestion(question.content);
		const formatted = formatQuestionForTelegram(question.id, question.content, options);
		const chunkCount = formatted.chunks.length;
		const messageIds: number[] = [];

		for (let i = 0; i < formatted.chunks.length; i++) {
			const isLast = i === formatted.chunks.length - 1;
			const replyMarkup = isLast && formatted.replyMarkup ? formatted.replyMarkup : undefined;
			let response: TelegramSendResponse;
			try {
				response = await this.opts.transport.send({
					botToken: creds.token,
					chatId: creds.chatId,
					text: formatted.chunks[i],
					parseMode: "HTML",
					...(replyMarkup ? { replyMarkup } : {}),
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				response = {
					kind: "error",
					httpStatus: null,
					errorCode: null,
					description: `network: ${message}`,
					retryAfterSeconds: null,
				};
			}

			if (response.kind === "ok") {
				messageIds.push(response.messageId);
				continue;
			}

			const reason = describeFailure(response);
			appendTelegramDelivery({
				kind: "forward-failure",
				timestamp: new Date().toISOString(),
				questionId: question.id,
				workflowId,
				reason,
				errorCode: response.errorCode,
			});
			this.opts.failureState.recordFailure(`forward:${question.id}`, reason);
			return;
		}

		if (messageIds.length === 0) return;

		const entry: ForwardedQuestion = {
			questionId: question.id,
			workflowId,
			chatId: creds.chatId,
			messageIds,
			options,
			forwardedAt: new Date().toISOString(),
		};

		try {
			await this.opts.store.add(entry);
		} catch (err) {
			logger.warn(`[telegram-forwarder] store.add failed: ${err}`);
		}

		appendTelegramDelivery({
			kind: "forward-success",
			timestamp: new Date().toISOString(),
			questionId: question.id,
			workflowId,
			chunkCount,
		});
	}

	/** Hook for `onQuestionAnswered`. */
	async handleAnswered(_workflowId: string, questionId: string): Promise<void> {
		try {
			const entry = await this.opts.store.removeByQuestionId(questionId);
			if (!entry) return;
			await this.deleteAllMessages(entry);
		} catch (err) {
			logger.warn(`[telegram-forwarder] handleAnswered threw: ${err}`);
		}
	}

	/** Hook for `onQuestionAborted`. */
	async handleAborted(_workflowId: string, questionId: string): Promise<void> {
		try {
			const entry = await this.opts.store.removeByQuestionId(questionId);
			if (!entry) return;
			await this.deleteAllMessages(entry);
		} catch (err) {
			logger.warn(`[telegram-forwarder] handleAborted threw: ${err}`);
		}
	}

	/** Inbound `callback_query` handler (button tap). */
	async handleInboundCallback(
		callbackQueryId: string,
		callbackData: string,
		messageId: number | null,
	): Promise<void> {
		const creds = this.opts.getSettings();
		const token = creds.botToken.trim();
		const entry = this.opts.store.getByCallbackData(callbackData);
		const key = this.opts.store.parseCallbackKey(callbackData);

		if (!entry || !key) {
			appendTelegramDelivery({
				kind: "inbound-stale",
				timestamp: new Date().toISOString(),
				chatId: this.opts.getSettings().chatId,
				messageId,
				callbackQueryId,
				reason: "no-matching-question",
			});
			if (token !== "") {
				await this.fireAndForgetCallbackAck(token, callbackQueryId, STALE_REPLY_TEXT);
				if (messageId !== null) {
					await this.deleteOne(creds.chatId, messageId, "stale");
				}
			}
			return;
		}

		appendTelegramDelivery({
			kind: "inbound-callback",
			timestamp: new Date().toISOString(),
			questionId: entry.questionId,
			callbackQueryId,
			data: callbackData,
		});

		// Acknowledge the spinner regardless of subsequent steps.
		if (token !== "") {
			await this.fireAndForgetCallbackAck(token, callbackQueryId);
		}

		// Remove from store BEFORE delivering the answer so a re-tap of a
		// duplicate update lands in the stale path.
		const removed = await this.opts.store.removeByQuestionId(entry.questionId);
		this.opts.answerQuestion(entry.workflowId, entry.questionId, key);
		if (removed) await this.deleteAllMessages(removed);
	}

	/** Inbound `message` handler (quote-reply or unsolicited message). */
	async handleInboundMessage(
		incomingMessageId: number,
		text: string,
		replyToMessageId: number | null,
		chatId: string,
	): Promise<void> {
		if (replyToMessageId === null) {
			appendTelegramDelivery({
				kind: "inbound-unbound",
				timestamp: new Date().toISOString(),
				chatId,
				messageId: incomingMessageId,
				reason: "no-reply",
			});
			await this.sendUnboundReply(incomingMessageId);
			return;
		}

		const entry = this.opts.store.getByMessageId(replyToMessageId);
		if (!entry) {
			// FR-009: a reply targeting a message we don't track. We cannot
			// distinguish "user replied to an unrelated bot message" from
			// "the question is genuinely stale". The unrelated case is far more
			// common in practice (notifications, old replies); guide the user
			// to the reply feature instead of misleading them with
			// "already answered".
			appendTelegramDelivery({
				kind: "inbound-unbound",
				timestamp: new Date().toISOString(),
				chatId,
				messageId: incomingMessageId,
				reason: "reply-to-unrelated",
			});
			await this.sendUnboundReply(incomingMessageId);
			return;
		}

		appendTelegramDelivery({
			kind: "inbound-message",
			timestamp: new Date().toISOString(),
			questionId: entry.questionId,
			messageId: incomingMessageId,
			replyToMessageId,
		});

		const removed = await this.opts.store.removeByQuestionId(entry.questionId);
		this.opts.answerQuestion(entry.workflowId, entry.questionId, text);
		if (removed) await this.deleteAllMessages(removed);
	}

	private async deleteAllMessages(entry: ForwardedQuestion): Promise<void> {
		for (const messageId of entry.messageIds) {
			await this.deleteOne(entry.chatId, messageId, entry.questionId);
		}
	}

	private async deleteOne(chatId: string, messageId: number, questionId: string): Promise<void> {
		const settings = this.opts.getSettings();
		const token = settings.botToken.trim();
		if (token === "") return;

		let attempts = 0;
		let lastFailure: Extract<DeleteMessageResponse, { kind: "error" }> | null = null;
		for (let attempt = 1; attempt <= DELETE_MAX_ATTEMPTS; attempt++) {
			attempts = attempt;
			let response: DeleteMessageResponse;
			try {
				response = await this.opts.transport.deleteMessage({
					botToken: token,
					chatId,
					messageId,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				response = {
					kind: "error",
					httpStatus: null,
					errorCode: null,
					description: `network: ${message}`,
					retryAfterSeconds: null,
				};
			}

			const category = categorizeRetry(response);
			if (category === "ok") {
				appendTelegramDelivery({
					kind: "delete-success",
					timestamp: new Date().toISOString(),
					questionId,
					messageId,
				});
				return;
			}

			lastFailure = response as Extract<DeleteMessageResponse, { kind: "error" }>;
			if (category === "fatal") break;

			if (attempt < DELETE_MAX_ATTEMPTS) {
				const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
				const retryAfterMs = (lastFailure.retryAfterSeconds ?? 0) * 1000;
				try {
					await this.opts.sleep(Math.max(exponential, retryAfterMs));
				} catch {
					/* ignore */
				}
			}
		}

		if (!lastFailure) return;
		appendTelegramDelivery({
			kind: "delete-failure",
			timestamp: new Date().toISOString(),
			questionId,
			messageId,
			attempts,
			reason: describeFailure(lastFailure),
			errorCode: lastFailure.errorCode,
		});
	}

	private async fireAndForgetCallbackAck(
		token: string,
		callbackQueryId: string,
		text?: string,
	): Promise<void> {
		try {
			await this.opts.transport.answerCallbackQuery({
				botToken: token,
				callbackQueryId,
				...(text !== undefined ? { text } : {}),
				showAlert: false,
			});
		} catch (err) {
			logger.info(`[telegram-forwarder] answerCallbackQuery error (ignored): ${err}`);
		}
	}

	private async sendUnboundReply(_messageId: number): Promise<void> {
		await this.sendInboundReply(UNBOUND_REPLY_TEXT);
	}

	private async sendInboundReply(text: string): Promise<void> {
		const settings = this.opts.getSettings();
		const token = settings.botToken.trim();
		const chatId = settings.chatId.trim();
		if (token === "" || chatId === "") return;
		try {
			await this.opts.transport.send({
				botToken: token,
				chatId,
				text,
				parseMode: "HTML",
			});
		} catch (err) {
			logger.info(`[telegram-forwarder] inbound reply send failed (ignored): ${err}`);
		}
	}
}
