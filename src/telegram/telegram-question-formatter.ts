import type { ForwardedQuestionOption } from "./telegram-question-store";

export const TELEGRAM_TEXT_LIMIT = 4096;

export interface FormattedQuestion {
	chunks: string[];
	replyMarkup: {
		inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
	} | null;
}

/**
 * Render a forwarded question into the chunk list (≤ 4096 chars each) plus
 * an optional inline keyboard. The keyboard, when present, is meant to be
 * attached **only on the last chunk** by the caller.
 */
export function formatQuestionForTelegram(
	questionId: string,
	content: string,
	options: ForwardedQuestionOption[] | null,
): FormattedQuestion {
	// Split the raw text first, then escape each chunk independently. Escaping
	// before splitting can land a hard-cut at 4096 inside an entity like `&amp;`,
	// which Telegram's HTML parser rejects with a 400. Escape can grow a chunk
	// (`&` → `&amp;`); re-split each escaped chunk to respect the 4096-char
	// wire limit.
	const chunks = splitForTelegram(content).flatMap((c) => splitForTelegram(escapeHtml(c)));
	const replyMarkup =
		options && options.length > 0
			? {
					inline_keyboard: options.map((opt) => [
						{
							text: opt.key,
							callback_data: `q:${questionId}:${opt.key}`,
						},
					]),
				}
			: null;
	return { chunks, replyMarkup };
}

/**
 * Split text into ≤ 4096-char chunks. Chunking prefers, in order:
 *   1. The nearest preceding double-newline boundary.
 *   2. The nearest preceding single-newline boundary.
 *   3. Hard cut at the limit.
 */
export function splitForTelegram(text: string): string[] {
	if (text.length <= TELEGRAM_TEXT_LIMIT) return [text];

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > TELEGRAM_TEXT_LIMIT) {
		const window = remaining.slice(0, TELEGRAM_TEXT_LIMIT);
		let cutAt: number;
		const dbl = window.lastIndexOf("\n\n");
		const single = window.lastIndexOf("\n");
		if (dbl >= TELEGRAM_TEXT_LIMIT / 4) {
			// keep the trailing "\n\n" on the previous chunk; resume after it
			cutAt = dbl + 2;
		} else if (single >= TELEGRAM_TEXT_LIMIT / 4) {
			cutAt = single + 1;
		} else {
			cutAt = TELEGRAM_TEXT_LIMIT;
		}
		chunks.push(remaining.slice(0, cutAt));
		remaining = remaining.slice(cutAt);
	}

	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
