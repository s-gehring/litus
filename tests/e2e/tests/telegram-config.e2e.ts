import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "../harness/fixtures";
import { readConfigJson } from "../helpers/config-actions";
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
		const saveBtn = page.locator(".cfg-tg-save-btn");

		await tokenInput.fill("real-bot-token-xyz");
		await chatInput.fill("@my-chat");
		await activeToggle.check();

		const broadcast = observer.waitFor((m) => m.type === "config:state");
		await saveBtn.click();
		await broadcast;

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

		// Happy path.
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

	test("US2: Acknowledge round-trip clears unacknowledgedCount and badge stays hidden when count=0", async ({
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

		// Save active+creds first so the notifier dispatches.
		const tokenInput = page.locator('input[data-cfg-path="telegram.botToken"]');
		const chatInput = page.locator('input[data-cfg-path="telegram.chatId"]');
		const activeToggle = page.locator('input[data-cfg-path="telegram.active"]');
		const saveBtn = page.locator(".cfg-tg-save-btn");
		await tokenInput.fill("tok");
		await chatInput.fill("@chat");
		await activeToggle.check();
		const savedBroadcast = observer.waitFor((m) => m.type === "config:state");
		await saveBtn.click();
		await savedBroadcast;

		// E2E coverage scope: the failure-state mutation path itself is
		// exhaustively covered by tests/unit/telegram-notifier.test.ts and
		// tests/integration/alert-telegram-pipeline.test.ts. Driving a real
		// in-app alert from the browser would require completing a full workflow,
		// which is far beyond this feature's scope. Here we validate the UI
		// surface end-to-end: the badge starts hidden, and the Acknowledge
		// round-trip works (server replies with a fresh telegram:status).

		// Verify the badge is initially hidden (unacknowledgedCount === 0).
		const badge = page.locator(".cfg-tg-failure-badge");
		await expect(badge).toHaveClass(/cfg-tg-failure-badge--hidden/);

		// Click Acknowledge anyway — must round-trip without throwing and the
		// server should re-broadcast a fresh telegram:status.
		const ackBtn = page.locator(".cfg-tg-ack-btn");
		const statusFrame = observer.waitFor((m) => m.type === "telegram:status");
		await ackBtn.click();
		const status = (await statusFrame) as {
			type: string;
			unacknowledgedCount: number;
			lastFailureReason: string | null;
		};
		expect(status.unacknowledgedCount).toBe(0);
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
		const saveBtn = page.locator(".cfg-tg-save-btn");
		await tokenInput.fill("tok");
		await chatInput.fill("@chat-real");
		await activeToggle.check();
		const broadcast = observer.waitFor((m) => m.type === "config:state");
		await saveBtn.click();
		await broadcast;

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
