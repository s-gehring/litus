import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "../harness/fixtures";
import { readConfigJson, setAndSave } from "../helpers/config-actions";
import { ServerMessageObserver } from "../helpers/server-messages";
import { AppPage, ConfigPage } from "../pages";

// Single per-suite stub-transport log file. The Playwright runner is single-
// worker (see playwright.config.ts), so colocating per-test artifacts under
// tmpdir is safe — the file is recreated per test via beforeEach.
const TG_LOG_PATH = join(tmpdir(), `litus-tg-e2e-${process.pid}.jsonl`);
const TG_MODE_PATH = `${TG_LOG_PATH}.mode`;

function setStubMode(mode: "ok" | "fail-401" | "fail-network"): void {
	writeFileSync(TG_MODE_PATH, mode, "utf8");
}

function readStubLog(): Array<{ chatId: string; text: string; mode: string }> {
	if (!existsSync(TG_LOG_PATH)) return [];
	const lines = readFileSync(TG_LOG_PATH, "utf8")
		.trim()
		.split("\n")
		.filter((l) => l.length > 0);
	return lines.map((l) => JSON.parse(l));
}

function clearStubArtifacts(): void {
	for (const p of [TG_LOG_PATH, TG_MODE_PATH]) {
		try {
			if (existsSync(p)) writeFileSync(p, "");
		} catch {
			// best-effort
		}
	}
}

test.use({
	scenarioName: "telegram-config",
	autoMode: "manual",
	serverExtraEnv: { LITUS_TELEGRAM_E2E_LOG: TG_LOG_PATH },
});
test.describe.configure({ timeout: 60_000 });

test.describe("Telegram notifications config", () => {
	test.beforeEach(() => {
		clearStubArtifacts();
		setStubMode("ok");
	});

	test("US1: configure + activate + reload — persisted, token masked", async ({
		page,
		server,
		sandbox,
	}) => {
		const observer = new ServerMessageObserver(page);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();
		await cfg.activateTab("telegram");

		const tokenInput = page.locator('input[data-cfg-path="telegram.botToken"]');
		const chatInput = page.locator('input[data-cfg-path="telegram.chatId"]');
		const activeToggle = page.locator('input[data-cfg-path="telegram.active"]');

		// Auto-save flow: each control commits its own change. Token + chat
		// must be saved BEFORE flipping active=true, otherwise activation fails
		// validation (FR-003: active requires non-empty creds).
		await setAndSave(observer, tokenInput, "real-bot-token-xyz");
		await setAndSave(observer, chatInput, "@my-chat");
		const activeBroadcast = observer.waitFor((m) => m.type === "config:state");
		await activeToggle.check();
		await activeBroadcast;

		// Reload — masked sentinel must come back, not the raw token.
		await page.reload();
		await app.waitConnected();
		await cfg.activateTab("telegram");
		await expect(tokenInput).toHaveValue("***configured***");
		await expect(chatInput).toHaveValue("@my-chat");
		await expect(activeToggle).toBeChecked();

		// On-disk ground truth: the plaintext token IS persisted (server-side
		// trust boundary), but the wire never carried it back.
		const onDisk = await readConfigJson(sandbox.homeDir);
		const telegram = onDisk.telegram as Record<string, unknown>;
		expect(telegram.botToken).toBe("real-bot-token-xyz");
		expect(telegram.chatId).toBe("@my-chat");
		expect(telegram.active).toBe(true);
	});

	test("US3: test message — success and 401 failure surface inline", async ({ page, server }) => {
		const observer = new ServerMessageObserver(page);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();
		await cfg.activateTab("telegram");

		const tokenInput = page.locator('input[data-cfg-path="telegram.botToken"]');
		const chatInput = page.locator('input[data-cfg-path="telegram.chatId"]');
		const testBtn = page.locator(".cfg-tg-test-btn");
		const status = page.locator(".cfg-tg-test-status");

		// Happy path. The test-message path reads creds straight from the
		// inputs, so a plain `fill` is enough — no save needed.
		setStubMode("ok");
		await tokenInput.fill("any");
		await chatInput.fill("@chat");
		const okFrame = observer.waitFor(
			(m) => m.type === "telegram:test-result" && (m as { ok?: unknown }).ok === true,
		);
		await testBtn.click();
		await okFrame;
		await expect(status).toHaveClass(/cfg-tg-test-status--ok/);
		await expect(status).toContainText("successfully");

		// Failure path.
		setStubMode("fail-401");
		const failFrame = observer.waitFor(
			(m) => m.type === "telegram:test-result" && (m as { ok?: unknown }).ok === false,
		);
		await testBtn.click();
		await failFrame;
		await expect(status).toHaveClass(/cfg-tg-test-status--error/);
		await expect(status).toContainText("401");
	});

	test("US2: failure badge stays hidden when there are no unacknowledged failures", async ({
		page,
		server,
	}) => {
		const observer = new ServerMessageObserver(page);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();
		await cfg.activateTab("telegram");

		// Save active+creds via auto-save so the notifier would dispatch on
		// future alerts. The failure-state mutation path itself is exhaustively
		// covered by tests/unit/telegram-notifier.test.ts and
		// tests/integration/alert-telegram-pipeline.test.ts; here we just
		// validate the resting UI state.
		const tokenInput = page.locator('input[data-cfg-path="telegram.botToken"]');
		const chatInput = page.locator('input[data-cfg-path="telegram.chatId"]');
		const activeToggle = page.locator('input[data-cfg-path="telegram.active"]');
		await setAndSave(observer, tokenInput, "tok");
		await setAndSave(observer, chatInput, "@chat");
		const activeBroadcast = observer.waitFor((m) => m.type === "config:state");
		await activeToggle.check();
		await activeBroadcast;

		// Badge is hidden whenever unacknowledgedCount === 0.
		const badge = page.locator(".cfg-tg-failure-badge");
		await expect(badge).toHaveClass(/cfg-tg-failure-badge--hidden/);
	});

	test("transport hook: test-message path reaches the real stub transport with configured chat", async ({
		page,
		server,
	}) => {
		const observer = new ServerMessageObserver(page);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();
		await cfg.activateTab("telegram");
		const tokenInput = page.locator('input[data-cfg-path="telegram.botToken"]');
		const chatInput = page.locator('input[data-cfg-path="telegram.chatId"]');
		const activeToggle = page.locator('input[data-cfg-path="telegram.active"]');
		await setAndSave(observer, tokenInput, "tok");
		await setAndSave(observer, chatInput, "@chat-real");
		const activeBroadcast = observer.waitFor((m) => m.type === "config:state");
		await activeToggle.check();
		await activeBroadcast;

		// Use the test-message path to drive the transport (US3 guarantees the
		// stub is hit). The stub log records every send call regardless of mode.
		setStubMode("ok");
		const testBtn = page.locator(".cfg-tg-test-btn");
		const testResult = observer.waitFor((m) => m.type === "telegram:test-result");
		await testBtn.click();
		await testResult;

		const calls = readStubLog();
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls[calls.length - 1].chatId).toBe("@chat-real");
		expect(calls[calls.length - 1].text).toContain("Litus test message");
	});
});
