import type { TelegramSettings } from "../config-types";
import { logger } from "../logger";
import type { TelegramFailureState } from "./telegram-failure-state";
import type { TelegramQuestionForwarder } from "./telegram-question-forwarder";
import type { GetUpdatesResponse, TelegramTransport } from "./telegram-transport";

export const POLL_TIMEOUT_SECONDS = 25;
const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1000;

export interface TelegramUpdatePollerOptions {
	transport: TelegramTransport;
	getSettings: () => TelegramSettings;
	failureState: TelegramFailureState;
	forwarder: TelegramQuestionForwarder;
	sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramUpdatePoller {
	private readonly opts: Required<TelegramUpdatePollerOptions>;
	private offset = 0;
	private readonly seenUpdateIds = new Set<number>();
	private running = false;
	private currentAbort: AbortController | null = null;
	private loopPromise: Promise<void> | null = null;

	constructor(options: TelegramUpdatePollerOptions) {
		this.opts = {
			sleep: options.sleep ?? defaultSleep,
			...options,
		};
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.loopPromise = this.loop();
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.currentAbort?.abort();
		try {
			await this.loopPromise;
		} catch {
			/* ignore */
		}
		this.loopPromise = null;
	}

	private async loop(): Promise<void> {
		let backoffAttempt = 0;
		while (this.running) {
			const settings = this.opts.getSettings();
			const token = settings.botToken.trim();
			const configuredChat = settings.chatId.trim();
			if (token === "" || configuredChat === "") {
				await this.opts.sleep(1000);
				continue;
			}

			this.currentAbort = new AbortController();
			let response: GetUpdatesResponse;
			try {
				response = await this.opts.transport.getUpdates(
					{
						botToken: token,
						offset: this.offset,
						timeout: POLL_TIMEOUT_SECONDS,
						allowedUpdates: ["message", "callback_query"],
					},
					this.currentAbort.signal,
				);
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

			if (!this.running) break;

			if (response.kind === "ok") {
				backoffAttempt = 0;
				let maxId = this.offset - 1;
				for (const u of response.updates) {
					if (this.seenUpdateIds.has(u.updateId)) continue;
					this.seenUpdateIds.add(u.updateId);
					if (u.updateId > maxId) maxId = u.updateId;

					if (u.message) {
						if (u.message.chatId !== configuredChat) continue;
						if (u.message.text === null) continue;
						await this.opts.forwarder.handleInboundMessage(
							u.message.messageId,
							u.message.text,
							u.message.replyToMessageId,
							u.message.chatId,
						);
					} else if (u.callbackQuery) {
						if (u.callbackQuery.chatId !== configuredChat) continue;
						if (u.callbackQuery.data === null) continue;
						await this.opts.forwarder.handleInboundCallback(
							u.callbackQuery.id,
							u.callbackQuery.data,
							u.callbackQuery.messageId,
						);
					}
				}
				if (response.updates.length > 0) this.offset = maxId + 1;
				continue;
			}

			// error path
			if (response.httpStatus === 401) {
				const reason = response.description ?? "Unauthorized";
				logger.warn(`[telegram-poller] fatal 401 — stopping. ${reason}`);
				this.opts.failureState.recordFailure("poller", `HTTP 401: ${reason}`);
				this.running = false;
				break;
			}

			backoffAttempt += 1;
			const retryAfterMs = (response.retryAfterSeconds ?? 0) * 1000;
			const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (backoffAttempt - 1), MAX_BACKOFF_MS);
			await this.opts.sleep(Math.max(exponential, retryAfterMs));
		}
	}
}
