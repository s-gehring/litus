import type { TelegramSettings } from "../config-types";
import { logger } from "../logger";
import type { Alert } from "../types";
import { appendTelegramDelivery } from "./telegram-audit";
import type { TelegramFailureState } from "./telegram-failure-state";
import { formatAlertForTelegram } from "./telegram-formatter";
import type { TelegramSendResponse, TelegramTransport } from "./telegram-transport";

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;

export interface TelegramNotifierOptions {
	getSettings: () => TelegramSettings;
	getBaseUrl: () => string;
	transport: TelegramTransport;
	failureState: TelegramFailureState;
	sleep?: (ms: number) => Promise<void>;
	maxAttempts?: number;
	baseBackoffMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function categorizeRetry(
	response: { kind: "ok" } | { kind: "error"; httpStatus: number | null },
): "ok" | "retryable" | "fatal" {
	if (response.kind === "ok") return "ok";
	const status = response.httpStatus;
	if (status === null) return "retryable"; // network throw
	if (status === 429) return "retryable";
	if (status >= 500 && status <= 599) return "retryable";
	return "fatal";
}

export function describeFailure(response: {
	httpStatus: number | null;
	description: string;
}): string {
	if (response.httpStatus === null) {
		return response.description.startsWith("network:")
			? response.description
			: `network: ${response.description}`;
	}
	return `HTTP ${response.httpStatus}: ${response.description}`;
}

export class TelegramNotifier {
	private readonly opts: Required<TelegramNotifierOptions>;
	private inflight: Promise<void> = Promise.resolve();

	constructor(options: TelegramNotifierOptions) {
		this.opts = {
			sleep: options.sleep ?? defaultSleep,
			maxAttempts: options.maxAttempts ?? MAX_ATTEMPTS,
			baseBackoffMs: options.baseBackoffMs ?? BASE_BACKOFF_MS,
			...options,
		};
		if (this.opts.maxAttempts < 1) {
			throw new Error("maxAttempts must be >= 1");
		}
	}

	/**
	 * Fire-and-forget dispatch. Always resolves (never rejects) so callers in
	 * the alert pipeline cannot have their hot path interrupted by a Telegram
	 * failure (FR-008). Alerts are dispatched serially via an internal promise
	 * chain so ordering is preserved (R9).
	 *
	 * The returned promise resolves when this *and every previously-queued*
	 * alert have completed dispatching — useful for tests that want to flush
	 * the queue (`await notifier.notify(lastAlert)`).
	 */
	notify(alert: Alert): Promise<void> {
		const next = this.inflight.then(() => this.dispatch(alert).catch(() => {}));
		this.inflight = next;
		return next;
	}

	/**
	 * Resolves when every currently-queued dispatch has settled. Intended for
	 * tests that fire alerts via a separate code path (e.g., emitAlert) and
	 * need to await the side-channel queue without injecting a synthetic alert.
	 */
	idle(): Promise<void> {
		return this.inflight;
	}

	private async dispatch(alert: Alert): Promise<void> {
		const settings = this.opts.getSettings();
		if (!settings.active) return;
		const token = settings.botToken.trim();
		const chatId = settings.chatId.trim();
		if (token === "" || chatId === "") return;

		const text = formatAlertForTelegram(alert, this.opts.getBaseUrl());

		let attempts = 0;
		let lastFailure: Extract<TelegramSendResponse, { kind: "error" }> | null = null;

		for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
			attempts = attempt;
			let response: TelegramSendResponse;
			try {
				response = await this.opts.transport.send({
					botToken: token,
					chatId,
					text,
					parseMode: "HTML",
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
					kind: "success",
					timestamp: new Date().toISOString(),
					alertId: alert.id,
					alertType: alert.type,
					attempts,
				});
				return;
			}

			lastFailure = response as Extract<TelegramSendResponse, { kind: "error" }>;
			if (category === "fatal") break;

			if (attempt < this.opts.maxAttempts) {
				const exponential = this.opts.baseBackoffMs * 2 ** (attempt - 1);
				const retryAfterMs = (lastFailure.retryAfterSeconds ?? 0) * 1000;
				const delay = Math.max(exponential, retryAfterMs);
				try {
					await this.opts.sleep(delay);
				} catch (err) {
					logger.warn(`[telegram] sleep interrupted: ${err}`);
				}
			}
		}

		// Unreachable: constructor asserts maxAttempts >= 1, so the loop body
		// runs at least once and either returns on success or sets lastFailure.
		if (!lastFailure) return;
		const reason = describeFailure(lastFailure);
		appendTelegramDelivery({
			kind: "failure",
			timestamp: new Date().toISOString(),
			alertId: alert.id,
			alertType: alert.type,
			attempts,
			reason,
			errorCode: lastFailure.errorCode,
		});
		this.opts.failureState.recordFailure(alert.id, reason);
	}
}
