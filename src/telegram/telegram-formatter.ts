import type { Alert, AlertType } from "../types";

const TYPE_LABELS: Record<AlertType, string> = {
	"workflow-finished": "Workflow finished",
	"epic-finished": "Epic finished",
	"question-asked": "Question asked",
	"pr-opened-manual": "PR opened (manual review)",
	error: "Error",
};

const MAX_TELEGRAM_TEXT_LENGTH = 4096;
const ELLIPSIS = "…";

function escapeHtml(value: string): string {
	return value.replace(/[<>&"']/g, (ch) => {
		switch (ch) {
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case "&":
				return "&amp;";
			case '"':
				return "&quot;";
			case "'":
				return "&#39;";
			default:
				return ch;
		}
	});
}

function originLine(alert: Alert): string {
	if (alert.workflowId) {
		return `Workflow: <code>${escapeHtml(alert.workflowId)}</code>`;
	}
	if (alert.epicId) {
		return `Epic: <code>${escapeHtml(alert.epicId)}</code>`;
	}
	return "";
}

function buildLink(targetRoute: string, baseUrl: string): string {
	const href = `${baseUrl}${targetRoute}`;
	return `<a href="${escapeHtml(href)}">Open in Litus</a>`;
}

/**
 * Format an alert into a Telegram message body. The reserved block
 * (type label, title, origin id, link) is never truncated; only the
 * description is shortened with `…` to keep the post-entity-parse length
 * within Telegram's 4096-char limit (data-model §6 / FR-006).
 */
export function formatAlertForTelegram(alert: Alert, baseUrl: string): string {
	const label = TYPE_LABELS[alert.type] ?? alert.type;
	const headerLines = [`<b>${escapeHtml(label)}</b>: ${escapeHtml(alert.title)}`];
	const origin = originLine(alert);
	if (origin) headerLines.push(origin);
	headerLines.push(buildLink(alert.targetRoute, baseUrl));

	const reserved = headerLines.join("\n");
	const escapedDescription = escapeHtml(alert.description ?? "");

	if (escapedDescription === "") {
		return reserved.length > MAX_TELEGRAM_TEXT_LENGTH
			? `${reserved.slice(0, MAX_TELEGRAM_TEXT_LENGTH - 1)}${ELLIPSIS}`
			: reserved;
	}

	const separator = "\n\n";
	const fullCandidate = `${reserved}${separator}${escapedDescription}`;
	if (fullCandidate.length <= MAX_TELEGRAM_TEXT_LENGTH) return fullCandidate;

	// Need to truncate the description portion.
	const reservedWithSep = `${reserved}${separator}`;
	const room = MAX_TELEGRAM_TEXT_LENGTH - reservedWithSep.length - ELLIPSIS.length;
	if (room <= 0) {
		// Reserved block alone consumes the whole budget; emit reserved + ellipsis only.
		const cap = MAX_TELEGRAM_TEXT_LENGTH - ELLIPSIS.length;
		return `${reserved.slice(0, cap)}${ELLIPSIS}`;
	}
	return `${reservedWithSep}${escapedDescription.slice(0, room)}${ELLIPSIS}`;
}

export const TELEGRAM_MAX_TEXT_LENGTH = MAX_TELEGRAM_TEXT_LENGTH;
