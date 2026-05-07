export interface TelegramRequest {
	botToken: string;
	chatId: string;
	text: string;
	parseMode: "HTML";
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

export interface TelegramTransport {
	send(req: TelegramRequest): Promise<TelegramResponse>;
}

interface TelegramWireResponse {
	ok?: boolean;
	error_code?: number;
	description?: string;
	parameters?: { retry_after?: number };
}

/** Production transport: a thin wrapper around `globalThis.fetch` that calls
 *  Telegram's `sendMessage` endpoint and collapses the response into a
 *  `TelegramResponse` discriminated union. The bot token only ever lives in
 *  the URL path, never in headers, body, or the returned response. */
export const fetchTelegramTransport: TelegramTransport = {
	async send(req: TelegramRequest): Promise<TelegramResponse> {
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
					// Disabled: the link points at the Litus host (default
					// `http://localhost:<port>`), which Telegram's preview fetcher
					// cannot resolve and produces an empty preview card.
					disable_web_page_preview: true,
				}),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				kind: "error",
				httpStatus: null,
				errorCode: null,
				description: `network: ${message}`,
				retryAfterSeconds: null,
			};
		}

		let body: TelegramWireResponse | null = null;
		try {
			body = (await res.json()) as TelegramWireResponse;
		} catch {
			body = null;
		}

		if (res.ok && body?.ok === true) {
			return { kind: "ok" };
		}

		const errorCode =
			typeof body?.error_code === "number"
				? body.error_code
				: res.status >= 500
					? res.status
					: null;
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
	},
};
