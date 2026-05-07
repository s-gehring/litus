import type { ConfigValidationError, TelegramSettings } from "../../config-types";
import { type ClientMessage, TELEGRAM_TOKEN_SENTINEL } from "../../protocol";

interface TelegramSectionApi {
	root: HTMLElement;
	applyConfig(telegram: TelegramSettings): void;
	applyStatus(status: TelegramStatusProjection): void;
	applyConfigError(errors: ConfigValidationError[]): void;
	applyTestResult(result: TelegramTestResult): void;
}

export interface TelegramStatusProjection {
	unacknowledgedCount: number;
	lastFailureReason: string | null;
	lastFailureAt: number | null;
}

export type TelegramTestResult =
	| { ok: true }
	| { ok: false; errorCode: number | null; reason: string };

let api: TelegramSectionApi | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
}

function formatTimestamp(at: number): string {
	try {
		return new Date(at).toLocaleString();
	} catch {
		return new Date(at).toISOString();
	}
}

export function buildTelegramSection(send: (msg: ClientMessage) => void): HTMLElement {
	const section = el("div", "cfg-section cfg-section--telegram");
	section.dataset.cfgSection = "telegram";

	const intro = el(
		"div",
		"cfg-subgroup-desc",
		"Forward every alert (workflow finished, epic finished, question asked, manual PR review, error) to a Telegram chat.",
	);
	section.appendChild(intro);

	// Auto-save matches the rest of the config page: every control commits its
	// own change as a partial `config:save`, the server validates+persists, and
	// the resulting `config:state` broadcast re-syncs the form.
	const saveTelegram = (patch: Partial<TelegramSettings>): void => {
		send({ type: "config:save", config: { telegram: patch } });
	};

	// ── Token ────────────────────────────────────────────────
	const tokenRow = el("div", "cfg-field-row");
	const tokenLabel = el("label", "cfg-label", "Bot token");
	const tokenInput = el("input", "cfg-text-input cfg-tg-token") as HTMLInputElement;
	tokenInput.type = "password";
	tokenInput.autocomplete = "off";
	tokenInput.placeholder = "123456789:ABC-...";
	tokenInput.dataset.cfgPath = "telegram.botToken";
	tokenInput.addEventListener("change", () => {
		saveTelegram({ botToken: tokenInput.value });
	});
	const tokenWrap = el("div", "cfg-input-wrap");
	tokenWrap.appendChild(tokenInput);
	tokenRow.appendChild(tokenLabel);
	tokenRow.appendChild(tokenWrap);
	section.appendChild(tokenRow);

	const tokenError = el("div", "cfg-field-error cfg-tg-error-token");
	tokenError.dataset.errorFor = "telegram.botToken";
	section.appendChild(tokenError);

	// ── Chat id ──────────────────────────────────────────────
	const chatRow = el("div", "cfg-field-row");
	const chatLabel = el("label", "cfg-label", "Chat identifier");
	const chatInput = el("input", "cfg-text-input cfg-tg-chat") as HTMLInputElement;
	chatInput.type = "text";
	chatInput.autocomplete = "off";
	chatInput.placeholder = "123456789 or @channelusername";
	chatInput.dataset.cfgPath = "telegram.chatId";
	chatInput.addEventListener("change", () => {
		saveTelegram({ chatId: chatInput.value });
	});
	const chatWrap = el("div", "cfg-input-wrap");
	chatWrap.appendChild(chatInput);
	chatRow.appendChild(chatLabel);
	chatRow.appendChild(chatWrap);
	section.appendChild(chatRow);

	const chatError = el("div", "cfg-field-error cfg-tg-error-chat");
	chatError.dataset.errorFor = "telegram.chatId";
	section.appendChild(chatError);

	// ── Activation toggle ───────────────────────────────────
	const toggleRow = el("div", "cfg-field-row cfg-field-row--toggle");
	const toggleInput = el("input", "cfg-tg-active") as HTMLInputElement;
	toggleInput.type = "checkbox";
	toggleInput.id = "cfg-tg-active";
	toggleInput.dataset.cfgPath = "telegram.active";
	toggleInput.addEventListener("change", () => {
		saveTelegram({ active: toggleInput.checked });
	});
	const toggleLabel = el(
		"label",
		"cfg-label cfg-tg-toggle-label",
		"Send notifications to Telegram",
	);
	toggleLabel.htmlFor = "cfg-tg-active";
	toggleRow.appendChild(toggleInput);
	toggleRow.appendChild(toggleLabel);
	section.appendChild(toggleRow);

	// ── Forward-questions toggle ────────────────────────────
	const forwardRow = el("div", "cfg-field-row cfg-field-row--toggle");
	const forwardInput = el("input", "cfg-tg-forward-questions") as HTMLInputElement;
	forwardInput.type = "checkbox";
	forwardInput.id = "cfg-tg-forward-questions";
	forwardInput.dataset.cfgPath = "telegram.forwardQuestions";
	forwardInput.addEventListener("change", () => {
		saveTelegram({ forwardQuestions: forwardInput.checked });
	});
	const forwardLabel = el(
		"label",
		"cfg-label cfg-tg-forward-questions-label",
		"Forward questions to Telegram",
	);
	forwardLabel.htmlFor = "cfg-tg-forward-questions";
	forwardRow.appendChild(forwardInput);
	forwardRow.appendChild(forwardLabel);
	section.appendChild(forwardRow);

	const forwardError = el("div", "cfg-field-error cfg-tg-error-forward-questions");
	forwardError.dataset.errorFor = "telegram.forwardQuestions";
	section.appendChild(forwardError);

	// ── Test action ─────────────────────────────────────────
	const actions = el("div", "cfg-tg-actions");

	const testBtn = el(
		"button",
		"btn btn-secondary cfg-tg-test-btn",
		"Send test message",
	) as HTMLButtonElement;
	testBtn.type = "button";
	testBtn.addEventListener("click", () => {
		setTestStatus("pending", "Sending…");
		send({
			type: "telegram:test",
			botToken: tokenInput.value,
			chatId: chatInput.value,
		});
	});
	actions.appendChild(testBtn);

	section.appendChild(actions);

	// ── Test result inline status ───────────────────────────
	const testStatus = el("div", "cfg-tg-test-status");
	section.appendChild(testStatus);

	function setTestStatus(kind: "ok" | "error" | "pending" | "idle", text: string): void {
		testStatus.className = `cfg-tg-test-status cfg-tg-test-status--${kind}`;
		testStatus.textContent = text;
	}

	// ── Failure indicator ───────────────────────────────────
	const failureBadge = el("div", "cfg-tg-failure-badge cfg-tg-failure-badge--hidden");
	const failureText = el("span", "cfg-tg-failure-text");
	failureBadge.appendChild(failureText);
	section.appendChild(failureBadge);

	function applyConfig(telegram: TelegramSettings): void {
		// Don't clobber what the user is actively editing.
		if (document.activeElement !== tokenInput) tokenInput.value = telegram.botToken;
		if (document.activeElement !== chatInput) chatInput.value = telegram.chatId;
		if (document.activeElement !== toggleInput) toggleInput.checked = telegram.active;
		if (document.activeElement !== forwardInput) {
			forwardInput.checked = telegram.forwardQuestions;
		}
		// Sentinel value in the token field is the cue that something is stored.
		tokenInput.placeholder =
			telegram.botToken === TELEGRAM_TOKEN_SENTINEL
				? "Saved — leave to keep, or replace with a new token"
				: "123456789:ABC-...";
		// Clear stale field errors after a successful broadcast.
		tokenError.textContent = "";
		chatError.textContent = "";
		forwardError.textContent = "";
	}

	function applyStatus(status: TelegramStatusProjection): void {
		if (status.unacknowledgedCount === 0) {
			failureBadge.classList.add("cfg-tg-failure-badge--hidden");
			failureText.textContent = "";
			return;
		}
		failureBadge.classList.remove("cfg-tg-failure-badge--hidden");
		const reason = status.lastFailureReason ?? "(no detail)";
		const at = status.lastFailureAt !== null ? ` at ${formatTimestamp(status.lastFailureAt)}` : "";
		const noun = status.unacknowledgedCount === 1 ? "failure" : "failures";
		failureText.textContent = `${status.unacknowledgedCount} recent delivery ${noun} — last: ${reason}${at}`;
	}

	function applyConfigError(errors: ConfigValidationError[]): void {
		const tokErr = errors.find((e) => e.path === "telegram.botToken");
		const chatErrItem = errors.find((e) => e.path === "telegram.chatId");
		const fwdErr = errors.find((e) => e.path === "telegram.forwardQuestions");
		tokenError.textContent = tokErr?.message ?? "";
		chatError.textContent = chatErrItem?.message ?? "";
		forwardError.textContent = fwdErr?.message ?? "";
	}

	function applyTestResult(result: TelegramTestResult): void {
		if (result.ok) {
			setTestStatus("ok", "Test message sent successfully");
			return;
		}
		const code = result.errorCode !== null ? `[${result.errorCode}] ` : "";
		setTestStatus("error", `${code}${result.reason}`);
	}

	api = { root: section, applyConfig, applyStatus, applyConfigError, applyTestResult };
	return section;
}

export function updateTelegramSection(telegram: TelegramSettings | undefined): void {
	if (!api || !telegram) return;
	api.applyConfig(telegram);
}

export function updateTelegramStatus(status: TelegramStatusProjection): void {
	api?.applyStatus(status);
}

export function applyTelegramConfigError(errors: ConfigValidationError[]): void {
	if (!api) return;
	if (!errors.some((e) => e.path.startsWith("telegram."))) return;
	api.applyConfigError(errors);
}

export function applyTelegramTestResult(result: TelegramTestResult): void {
	api?.applyTestResult(result);
}

/** Reset module state when the config page unmounts. */
export function disposeTelegramSection(): void {
	api = null;
}
