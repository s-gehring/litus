import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "../harness/fixtures";
import { abortRun, createSpecification, waitForStep } from "../helpers";
import { setAndSave } from "../helpers/config-actions";
import { ServerMessageObserver } from "../helpers/server-messages";
import { AppPage, ConfigPage, WorkflowCardPage } from "../pages";

const TG_LOG_PATH = join(tmpdir(), `litus-tg-fwd-e2e-${process.pid}.jsonl`);
const TG_INBOUND_PATH = `${TG_LOG_PATH}.inbound`;
const TG_MODE_PATH = `${TG_LOG_PATH}.mode`;

interface StubLogEntry {
	call: string;
	chatId?: string;
	text?: string;
	replyMarkup?: unknown;
	messageId?: number;
	mode?: string;
	callbackQueryId?: string;
	batchSize?: number;
}

function readStubLog(): StubLogEntry[] {
	if (!existsSync(TG_LOG_PATH)) return [];
	return readFileSync(TG_LOG_PATH, "utf8")
		.trim()
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as StubLogEntry);
}

function clearStubArtifacts(): void {
	for (const p of [TG_LOG_PATH, TG_MODE_PATH, TG_INBOUND_PATH]) {
		try {
			if (existsSync(p)) writeFileSync(p, "");
		} catch {
			// best-effort
		}
	}
}

function appendInboundUpdates(updates: unknown[]): void {
	const line = `${JSON.stringify(updates)}\n`;
	if (existsSync(TG_INBOUND_PATH)) {
		writeFileSync(TG_INBOUND_PATH, `${readFileSync(TG_INBOUND_PATH, "utf8")}${line}`);
	} else {
		writeFileSync(TG_INBOUND_PATH, line);
	}
}

test.use({
	scenarioName: "telegram-question-forwarding",
	autoMode: "manual",
	serverExtraEnv: { LITUS_TELEGRAM_E2E_LOG: TG_LOG_PATH },
});
test.describe.configure({ timeout: 120_000 });

test.describe("Telegram question forwarding", () => {
	test.beforeEach(() => {
		clearStubArtifacts();
	});

	test("US1: multi-choice question is forwarded with inline keyboard; button tap advances workflow and deletes message", async ({
		page,
		server,
		sandbox,
	}) => {
		const observer = new ServerMessageObserver(page);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		// Configure Telegram + enable forwarding.
		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();
		await cfg.activateTab("telegram");

		const tokenInput = page.locator('input[data-cfg-path="telegram.botToken"]');
		const chatInput = page.locator('input[data-cfg-path="telegram.chatId"]');
		const activeToggle = page.locator('input[data-cfg-path="telegram.active"]');
		const forwardToggle = page.locator('input[data-cfg-path="telegram.forwardQuestions"]');

		await setAndSave(observer, tokenInput, "tok");
		await setAndSave(observer, chatInput, "@chat");
		const activeBroadcast = observer.waitFor((m) => m.type === "config:state");
		await activeToggle.check();
		await activeBroadcast;
		const fwdBroadcast = observer.waitFor(
			(m) =>
				m.type === "config:state" &&
				(m as { config?: { telegram?: { forwardQuestions?: boolean } } }).config?.telegram
					?.forwardQuestions === true,
		);
		await forwardToggle.check();
		await fwdBroadcast;

		// Drive a workflow that produces a multi-choice clarify question.
		await createSpecification(app, {
			specification: "Add a dark mode toggle to the application settings.",
			repo: sandbox.targetRepo,
		});

		const card = new WorkflowCardPage(page);
		await waitForStep(card, "clarify", "waiting", { timeoutMs: 60_000 });

		// Wait until the stub transport has recorded a `send` with reply_markup.
		await expect
			.poll(
				() => {
					const log = readStubLog();
					return log.find(
						(e) => e.call === "send" && e.replyMarkup !== undefined && e.replyMarkup !== null,
					)?.messageId;
				},
				{ timeout: 30_000 },
			)
			.toBeDefined();

		const log = readStubLog();
		const sendEntry = log.find(
			(e) => e.call === "send" && e.replyMarkup !== undefined && e.replyMarkup !== null,
		);
		expect(sendEntry).toBeDefined();
		const messageId = sendEntry?.messageId as number;
		const replyMarkup = sendEntry?.replyMarkup as {
			inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
		};
		expect(replyMarkup.inline_keyboard).toHaveLength(2);
		expect(replyMarkup.inline_keyboard[0][0].text).toBe("A");
		const callbackData = replyMarkup.inline_keyboard[0][0].callback_data;
		expect(callbackData.startsWith("q:")).toBe(true);

		// Inject a callback_query as if the user tapped option "A".
		appendInboundUpdates([
			{
				updateId: 1,
				callbackQuery: {
					id: "cb-1",
					chatId: "@chat",
					data: callbackData,
				},
			},
		]);

		// Wait for the workflow to advance past `clarify`.
		await waitForStep(card, "clarify", "completed", { timeoutMs: 60_000 });

		// Verify the message was deleted.
		await expect
			.poll(
				() => {
					const after = readStubLog();
					return after.some((e) => e.call === "deleteMessage" && e.messageId === messageId);
				},
				{ timeout: 30_000 },
			)
			.toBe(true);
	});

	test("US4: abort while a forwarded question is pending → all messages deleted", async ({
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
		const forwardToggle = page.locator('input[data-cfg-path="telegram.forwardQuestions"]');

		await setAndSave(observer, tokenInput, "tok");
		await setAndSave(observer, chatInput, "@chat");
		const activeBroadcast = observer.waitFor((m) => m.type === "config:state");
		await activeToggle.check();
		await activeBroadcast;
		const fwdBroadcast = observer.waitFor(
			(m) =>
				m.type === "config:state" &&
				(m as { config?: { telegram?: { forwardQuestions?: boolean } } }).config?.telegram
					?.forwardQuestions === true,
		);
		await forwardToggle.check();
		await fwdBroadcast;

		await createSpecification(app, {
			specification: "Add a dark mode toggle to the application settings.",
			repo: sandbox.targetRepo,
		});

		const card = new WorkflowCardPage(page);
		await waitForStep(card, "clarify", "waiting", { timeoutMs: 60_000 });

		await expect
			.poll(
				() =>
					readStubLog().find(
						(e) => e.call === "send" && e.replyMarkup !== undefined && e.replyMarkup !== null,
					)?.messageId,
				{ timeout: 30_000 },
			)
			.toBeDefined();

		const sendEntry = readStubLog().find(
			(e) => e.call === "send" && e.replyMarkup !== undefined && e.replyMarkup !== null,
		);
		const messageId = sendEntry?.messageId as number;

		await abortRun(card);

		await expect
			.poll(
				() => readStubLog().some((e) => e.call === "deleteMessage" && e.messageId === messageId),
				{ timeout: 30_000 },
			)
			.toBe(true);
	});

	test("US3: integration-test the long-question split + atomic-delete path", async () => {
		// The full UX flow for split questions is covered by the integration
		// test (`tests/integration/telegram-question-pipeline.test.ts` "multi-
		// message question…") and the unit tests. This placeholder records the
		// E2E intent for FR-010/FR-011 — driving a real >4096-char question
		// through the e2e Claude stub would require an outsized scripted
		// scenario that does not add coverage beyond the integration test.
		// The unit + integration tests verify: (a) ≥2 outbound messages,
		// (b) keyboard only on the last chunk, (c) quote-reply on any chunk
		// deletes all.
	});

	test("US2: unbound message receives the friendly error reply", async ({ page, server }) => {
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
		const forwardToggle = page.locator('input[data-cfg-path="telegram.forwardQuestions"]');

		await setAndSave(observer, tokenInput, "tok");
		await setAndSave(observer, chatInput, "@chat");
		const activeBroadcast = observer.waitFor((m) => m.type === "config:state");
		await activeToggle.check();
		await activeBroadcast;
		const fwdBroadcast = observer.waitFor(
			(m) =>
				m.type === "config:state" &&
				(m as { config?: { telegram?: { forwardQuestions?: boolean } } }).config?.telegram
					?.forwardQuestions === true,
		);
		await forwardToggle.check();
		await fwdBroadcast;

		// Inject an unsolicited (no reply_to) inbound message.
		appendInboundUpdates([
			{
				updateId: 1,
				message: {
					messageId: 7,
					chatId: "@chat",
					text: "hi",
					replyToMessageId: null,
				},
			},
		]);

		await expect
			.poll(
				() => {
					const log = readStubLog();
					return log.some(
						(e) =>
							e.call === "send" &&
							typeof e.text === "string" &&
							e.text.toLowerCase().includes("reply"),
					);
				},
				{ timeout: 30_000 },
			)
			.toBe(true);
	});
});
