export interface TelegramRequest {
	botToken: string;
	chatId: string;
	text: string;
	parseMode: "HTML";
	/** Present only on the final chunk of a multi-choice forwarded question. */
	replyMarkup?: {
		inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
	};
}

export type TelegramResponse =
	| { kind: "ok" }
	| {
			kind: "error";
			httpStatus: number | null;
			errorCode: number | null;
			description: string;
			retryAfterSeconds: number | null;
	  };

export type TelegramSendResponse =
	| { kind: "ok"; messageId: number }
	| {
			kind: "error";
			httpStatus: number | null;
			errorCode: number | null;
			description: string;
			retryAfterSeconds: number | null;
	  };

export interface DeleteMessageRequest {
	botToken: string;
	chatId: string;
	messageId: number;
}

export type DeleteMessageResponse =
	| { kind: "ok" }
	| {
			kind: "error";
			httpStatus: number | null;
			errorCode: number | null;
			description: string;
			retryAfterSeconds: number | null;
	  };

export interface AnswerCallbackQueryRequest {
	botToken: string;
	callbackQueryId: string;
	text?: string;
	showAlert?: boolean;
}

export interface GetUpdatesRequest {
	botToken: string;
	offset: number;
	/** Long-poll seconds. The implementation uses 25. */
	timeout: number;
	allowedUpdates: ["message", "callback_query"];
}

export interface PollerUpdate {
	updateId: number;
	message?: {
		messageId: number;
		chatId: string;
		text: string | null;
		replyToMessageId: number | null;
	};
	callbackQuery?: {
		id: string;
		chatId: string | null;
		data: string | null;
		messageId: number | null;
	};
}

export type GetUpdatesResponse =
	| { kind: "ok"; updates: PollerUpdate[] }
	| {
			kind: "error";
			httpStatus: number | null;
			errorCode: number | null;
			description: string;
			retryAfterSeconds: number | null;
	  };

export interface TelegramTransport {
	send(req: TelegramRequest): Promise<TelegramSendResponse>;
	deleteMessage(req: DeleteMessageRequest): Promise<DeleteMessageResponse>;
	answerCallbackQuery(req: AnswerCallbackQueryRequest): Promise<DeleteMessageResponse>;
	getUpdates(req: GetUpdatesRequest, signal: AbortSignal): Promise<GetUpdatesResponse>;
}

interface TelegramWireResponse {
	ok?: boolean;
	error_code?: number;
	description?: string;
	parameters?: { retry_after?: number };
	result?: unknown;
}

interface SendMessageResult {
	message_id?: number;
}

interface UpdateWire {
	update_id?: number;
	message?: {
		message_id?: number;
		chat?: { id?: number | string };
		text?: string;
		reply_to_message_id?: number;
		reply_to_message?: { message_id?: number };
	};
	callback_query?: {
		id?: string;
		from?: { id?: number };
		message?: { chat?: { id?: number | string }; message_id?: number };
		data?: string;
	};
}

function errorFromResponse(
	res: Response,
	body: TelegramWireResponse | null,
): Extract<TelegramSendResponse, { kind: "error" }> {
	const errorCode =
		typeof body?.error_code === "number" ? body.error_code : res.status >= 500 ? res.status : null;
	const description = body?.description ?? res.statusText ?? `HTTP ${res.status}`;
	const retryAfterSeconds =
		typeof body?.parameters?.retry_after === "number" ? body.parameters.retry_after : null;
	return {
		kind: "error",
		httpStatus: res.status,
		errorCode,
		description,
		retryAfterSeconds,
	};
}

function networkError(err: unknown): Extract<TelegramSendResponse, { kind: "error" }> {
	const message = err instanceof Error ? err.message : String(err);
	return {
		kind: "error",
		httpStatus: null,
		errorCode: null,
		description: `network: ${message}`,
		retryAfterSeconds: null,
	};
}

/** Production transport: a thin wrapper around `globalThis.fetch` that calls
 *  the Telegram Bot API and collapses each response into a typed discriminated
 *  union. The bot token only ever lives in the URL path, never in headers,
 *  body, or the returned response. */
export const fetchTelegramTransport: TelegramTransport = {
	async send(req: TelegramRequest): Promise<TelegramSendResponse> {
		const url = `https://api.telegram.org/bot${req.botToken}/sendMessage`;
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: req.chatId,
					text: req.text,
					parse_mode: req.parseMode,
					disable_web_page_preview: true,
					...(req.replyMarkup ? { reply_markup: req.replyMarkup } : {}),
				}),
			});
		} catch (err) {
			return networkError(err);
		}

		let body: TelegramWireResponse | null = null;
		try {
			body = (await res.json()) as TelegramWireResponse;
		} catch {
			body = null;
		}

		if (res.ok && body?.ok === true) {
			const result = body.result as SendMessageResult | undefined;
			const messageId = typeof result?.message_id === "number" ? result.message_id : 0;
			return { kind: "ok", messageId };
		}

		return errorFromResponse(res, body);
	},

	async deleteMessage(req: DeleteMessageRequest): Promise<DeleteMessageResponse> {
		const url = `https://api.telegram.org/bot${req.botToken}/deleteMessage`;
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: req.chatId,
					message_id: req.messageId,
				}),
			});
		} catch (err) {
			return networkError(err);
		}

		let body: TelegramWireResponse | null = null;
		try {
			body = (await res.json()) as TelegramWireResponse;
		} catch {
			body = null;
		}

		if (res.ok && body?.ok === true) return { kind: "ok" };
		return errorFromResponse(res, body);
	},

	async answerCallbackQuery(req: AnswerCallbackQueryRequest): Promise<DeleteMessageResponse> {
		const url = `https://api.telegram.org/bot${req.botToken}/answerCallbackQuery`;
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					callback_query_id: req.callbackQueryId,
					...(req.text !== undefined ? { text: req.text } : {}),
					...(req.showAlert !== undefined ? { show_alert: req.showAlert } : {}),
				}),
			});
		} catch (err) {
			return networkError(err);
		}

		let body: TelegramWireResponse | null = null;
		try {
			body = (await res.json()) as TelegramWireResponse;
		} catch {
			body = null;
		}

		if (res.ok && body?.ok === true) return { kind: "ok" };
		return errorFromResponse(res, body);
	},

	async getUpdates(req: GetUpdatesRequest, signal: AbortSignal): Promise<GetUpdatesResponse> {
		const url = `https://api.telegram.org/bot${req.botToken}/getUpdates`;
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					offset: req.offset,
					timeout: req.timeout,
					allowed_updates: req.allowedUpdates,
				}),
				signal,
			});
		} catch (err) {
			return networkError(err);
		}

		let body: TelegramWireResponse | null = null;
		try {
			body = (await res.json()) as TelegramWireResponse;
		} catch {
			body = null;
		}

		if (res.ok && body?.ok === true) {
			const wireUpdates = (Array.isArray(body.result) ? body.result : []) as UpdateWire[];
			const updates: PollerUpdate[] = [];
			for (const u of wireUpdates) {
				if (typeof u.update_id !== "number") continue;
				const out: PollerUpdate = { updateId: u.update_id };
				if (u.message && typeof u.message.message_id === "number") {
					const chatId = u.message.chat?.id !== undefined ? String(u.message.chat.id) : "";
					out.message = {
						messageId: u.message.message_id,
						chatId,
						text: typeof u.message.text === "string" ? u.message.text : null,
						replyToMessageId:
							typeof u.message.reply_to_message_id === "number"
								? u.message.reply_to_message_id
								: typeof u.message.reply_to_message?.message_id === "number"
									? u.message.reply_to_message.message_id
									: null,
					};
				}
				if (u.callback_query && typeof u.callback_query.id === "string") {
					const chatId =
						u.callback_query.message?.chat?.id !== undefined
							? String(u.callback_query.message.chat.id)
							: null;
					out.callbackQuery = {
						id: u.callback_query.id,
						chatId,
						data: typeof u.callback_query.data === "string" ? u.callback_query.data : null,
						messageId:
							typeof u.callback_query.message?.message_id === "number"
								? u.callback_query.message.message_id
								: null,
					};
				}
				updates.push(out);
			}
			return { kind: "ok", updates };
		}

		return errorFromResponse(res, body);
	},
};
