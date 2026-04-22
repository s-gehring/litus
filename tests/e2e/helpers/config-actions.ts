import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import type { ConfigPage } from "../pages/config";
import type { ServerMessageObserver } from "./server-messages";

/**
 * Config-page flow helpers. The config page auto-saves on every control's
 * `change` event (see `src/client/components/config-page.ts`), so "save" here
 * just means filling the field and dispatching `change` so the client sends
 * `config:save` over the WebSocket. Playwright's `.fill()` does not fire
 * `change` for text inputs / textareas — only `input` — which is why we
 * dispatch it explicitly.
 *
 * Callers pass a `ServerMessageObserver` so we wait for the server's
 * `config:state` broadcast (the real "saved" signal) rather than relying on
 * implementation details of the sync `writeFileSync` path in ConfigStore.
 */

export async function setAndSave(
	observer: ServerMessageObserver,
	locator: Locator,
	value: string,
): Promise<void> {
	const broadcast = observer.waitFor((m) => m.type === "config:state");
	await locator.fill(value);
	await locator.dispatchEvent("change");
	await broadcast;
	await expect(locator).toHaveValue(value, { timeout: 5_000 });
}

export async function selectAndSave(
	observer: ServerMessageObserver,
	select: Locator,
	value: string,
): Promise<void> {
	const broadcast = observer.waitFor((m) => m.type === "config:state");
	// `selectOption` fires both `input` and `change`, so no dispatch needed.
	await select.selectOption(value);
	await broadcast;
	await expect(select).toHaveValue(value, { timeout: 5_000 });
}

export async function reloadConfigPage(cfg: ConfigPage): Promise<void> {
	await cfg.page.reload();
	await cfg.root().waitFor();
}

/**
 * Click "Reset all to defaults". There is no confirmation dialog for the
 * global reset (see `config-page.ts:559-564`). Waits for the server's
 * `config:state` broadcast before returning.
 */
export async function resetToDefaults(
	cfg: ConfigPage,
	observer: ServerMessageObserver,
): Promise<void> {
	const broadcast = observer.waitFor((m) => m.type === "config:state");
	await cfg.resetAllButton().click();
	await broadcast;
}

export interface PurgeAllOptions {
	/** Expected terminal state. Default: `"complete"`. */
	expect?: "complete" | "error";
	/** Max wait (ms) for the terminal purge event. Default: 30_000. */
	timeoutMs?: number;
}

/**
 * Click "Purge All Data" and accept the `window.confirm(...)` dialog. Waits
 * for the `purge:complete` broadcast (or `purge:error` when
 * `options.expect === "error"`) rather than for the overlay's DOM state, so
 * a purge that stalls without ever rendering the overlay still surfaces as a
 * timeout.
 *
 * `purge:error` does NOT navigate the client back to `/` (only `purge:complete`
 * does — see `src/client/app.ts:273-290`). When asserting against the global
 * `#output-log` after a scripted purge failure, the caller is responsible for
 * navigating to `/` first.
 */
export async function purgeAll(
	cfg: ConfigPage,
	observer: ServerMessageObserver,
	options?: PurgeAllOptions,
): Promise<void> {
	const expectState = options?.expect ?? "complete";
	const timeoutMs = options?.timeoutMs ?? 30_000;
	const terminalType = expectState === "complete" ? "purge:complete" : "purge:error";

	cfg.page.once("dialog", async (dialog) => {
		await dialog.accept();
	});
	const terminal = observer.waitFor((m) => m.type === terminalType, timeoutMs);
	await cfg.purgeAllButton().click();
	await terminal;
}

export async function readConfigJson(homeDir: string): Promise<Record<string, unknown>> {
	const path = join(homeDir, ".litus", "config.json");
	if (!existsSync(path)) return {};
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

/**
 * Wait until the DOM control at the given `data-cfg-path` reflects a value —
 * the signal that the server's `config:state` broadcast has come back and
 * `updateConfigPage` has re-synced the form.
 */
export async function expectConfigFieldValue(
	page: Page,
	path: string,
	value: string,
): Promise<void> {
	await expect(
		page.locator(
			`input[data-cfg-path="${path}"], textarea[data-cfg-path="${path}"], select[data-cfg-path="${path}"]`,
		),
	).toHaveValue(value, { timeout: 5_000 });
}
