import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelegramSettings } from "../../src/config-types";
import { setLitusHome } from "../../src/litus-paths";
import { TelegramFailureState } from "../../src/telegram/telegram-failure-state";
import type { TelegramQuestionForwarder } from "../../src/telegram/telegram-question-forwarder";
import type {
	GetUpdatesResponse,
	PollerUpdate,
	TelegramTransport,
} from "../../src/telegram/telegram-transport";
import { TelegramUpdatePoller } from "../../src/telegram/telegram-update-poller";

interface PollerHarness {
	transport: TelegramTransport;
	pushUpdates(updates: PollerUpdate[]): void;
	pushError(httpStatus: number): void;
	getUpdatesArgs: number[];
}

function makeHarness(): PollerHarness {
	const inbound: GetUpdatesResponse[] = [];
	const harness: PollerHarness = {
		getUpdatesArgs: [],
		transport: {
			async send() {
				return { kind: "ok", messageId: 1 };
			},
			async deleteMessage() {
				return { kind: "ok" };
			},
			async answerCallbackQuery() {
				return { kind: "ok" };
			},
			async getUpdates(req) {
				harness.getUpdatesArgs.push(req.offset);
				const next = inbound.shift();
				if (next) return next;
				await new Promise((r) => setTimeout(r, 5));
				return { kind: "ok", updates: [] };
			},
		},
		pushUpdates(updates) {
			inbound.push({ kind: "ok", updates });
		},
		pushError(httpStatus) {
			inbound.push({
				kind: "error",
				httpStatus,
				errorCode: httpStatus,
				description: "boom",
				retryAfterSeconds: null,
			});
		},
	};
	return harness;
}

function makeSettings(): TelegramSettings {
	return { botToken: "T", chatId: "@chat", active: true, forwardQuestions: true };
}

describe("TelegramUpdatePoller", () => {
	let homeDir: string;

	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "tg-poller-"));
		setLitusHome(homeDir);
	});

	afterEach(() => {
		rmSync(homeDir, { recursive: true, force: true });
	});

	test("routes message updates with reply_to_message_id to the forwarder", async () => {
		const harness = makeHarness();
		const calls: Array<[number, string, number | null, string]> = [];
		const forwarder = {
			handleInboundCallback: async () => {},
			handleInboundMessage: async (
				mid: number,
				text: string,
				replyTo: number | null,
				chatId: string,
			) => {
				calls.push([mid, text, replyTo, chatId]);
			},
		} as unknown as TelegramQuestionForwarder;
		const poller = new TelegramUpdatePoller({
			transport: harness.transport,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			forwarder,
			sleep: async () => {},
		});

		harness.pushUpdates([
			{
				updateId: 5,
				message: {
					messageId: 100,
					chatId: "@chat",
					text: "my reply",
					replyToMessageId: 42,
				},
			},
		]);

		poller.start();
		await new Promise((r) => setTimeout(r, 100));
		await poller.stop();

		expect(calls).toEqual([[100, "my reply", 42, "@chat"]]);
		// Offset should advance past the seen update.
		expect(harness.getUpdatesArgs[harness.getUpdatesArgs.length - 1]).toBe(6);
	});

	test("routes message updates without reply_to to the forwarder (unbound)", async () => {
		const harness = makeHarness();
		const calls: Array<[number, string, number | null]> = [];
		const forwarder = {
			handleInboundCallback: async () => {},
			handleInboundMessage: async (mid: number, text: string, replyTo: number | null) => {
				calls.push([mid, text, replyTo]);
			},
		} as unknown as TelegramQuestionForwarder;
		const poller = new TelegramUpdatePoller({
			transport: harness.transport,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			forwarder,
			sleep: async () => {},
		});

		harness.pushUpdates([
			{
				updateId: 5,
				message: {
					messageId: 100,
					chatId: "@chat",
					text: "hello",
					replyToMessageId: null,
				},
			},
		]);

		poller.start();
		await new Promise((r) => setTimeout(r, 100));
		await poller.stop();

		expect(calls).toEqual([[100, "hello", null]]);
	});

	test("drops updates from other chats (FR-017)", async () => {
		const harness = makeHarness();
		const calls: Array<[number, string]> = [];
		const forwarder = {
			handleInboundCallback: async () => {},
			handleInboundMessage: async (mid: number, text: string) => {
				calls.push([mid, text]);
			},
		} as unknown as TelegramQuestionForwarder;
		const poller = new TelegramUpdatePoller({
			transport: harness.transport,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			forwarder,
			sleep: async () => {},
		});

		harness.pushUpdates([
			{
				updateId: 1,
				message: {
					messageId: 100,
					chatId: "@otherchat",
					text: "hi",
					replyToMessageId: null,
				},
			},
		]);

		poller.start();
		await new Promise((r) => setTimeout(r, 100));
		await poller.stop();

		expect(calls).toHaveLength(0);
	});

	test("401 stops the poll loop and records failure", async () => {
		const harness = makeHarness();
		const failureState = new TelegramFailureState();
		const forwarder = {
			handleInboundCallback: async () => {},
			handleInboundMessage: async () => {},
		} as unknown as TelegramQuestionForwarder;
		const poller = new TelegramUpdatePoller({
			transport: harness.transport,
			getSettings: makeSettings,
			failureState,
			forwarder,
			sleep: async () => {},
		});

		harness.pushError(401);
		poller.start();
		await new Promise((r) => setTimeout(r, 100));
		await poller.stop();

		expect(failureState.getStatus().unacknowledgedCount).toBe(1);
	});
});
