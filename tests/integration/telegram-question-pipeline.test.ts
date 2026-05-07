import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelegramSettings } from "../../src/config-types";
import { setLitusHome } from "../../src/litus-paths";
import { TelegramFailureState } from "../../src/telegram/telegram-failure-state";
import { TelegramQuestionForwarder } from "../../src/telegram/telegram-question-forwarder";
import { TelegramQuestionStore } from "../../src/telegram/telegram-question-store";
import type {
	AnswerCallbackQueryRequest,
	DeleteMessageRequest,
	DeleteMessageResponse,
	GetUpdatesResponse,
	PollerUpdate,
	TelegramRequest,
	TelegramSendResponse,
	TelegramTransport,
} from "../../src/telegram/telegram-transport";
import { TelegramUpdatePoller } from "../../src/telegram/telegram-update-poller";
import type { Question } from "../../src/types";

interface RecordingTransport extends TelegramTransport {
	sendCalls: TelegramRequest[];
	deleteCalls: DeleteMessageRequest[];
	answerCalls: AnswerCallbackQueryRequest[];
	enqueueUpdates(updates: PollerUpdate[]): void;
}

function makeTransport(): RecordingTransport {
	const inbound: PollerUpdate[][] = [];
	let nextMessageId = 1000;
	const t: RecordingTransport = {
		sendCalls: [],
		deleteCalls: [],
		answerCalls: [],
		enqueueUpdates(updates) {
			inbound.push(updates);
		},
		async send(req: TelegramRequest): Promise<TelegramSendResponse> {
			t.sendCalls.push(req);
			return { kind: "ok", messageId: nextMessageId++ };
		},
		async deleteMessage(req: DeleteMessageRequest): Promise<DeleteMessageResponse> {
			t.deleteCalls.push(req);
			return { kind: "ok" };
		},
		async answerCallbackQuery(req: AnswerCallbackQueryRequest): Promise<DeleteMessageResponse> {
			t.answerCalls.push(req);
			return { kind: "ok" };
		},
		async getUpdates(): Promise<GetUpdatesResponse> {
			const next = inbound.shift();
			if (!next) {
				await new Promise((r) => setTimeout(r, 10));
				return { kind: "ok", updates: [] };
			}
			return { kind: "ok", updates: next };
		},
	};
	return t;
}

function makeSettings(): TelegramSettings {
	return { botToken: "TOK", chatId: "@chat", active: true, forwardQuestions: true };
}

function makeQuestion(): Question {
	return {
		id: "q-1",
		content: "| K | D |\n| --- | --- |\n| A | First |\n| B | Second |",
		detectedAt: "2026-05-07T12:00:00.000Z",
	};
}

describe("Telegram question pipeline (forwarder + poller + transport)", () => {
	let homeDir: string;
	let storePath: string;

	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "tg-q-pipeline-"));
		setLitusHome(homeDir);
		storePath = join(homeDir, "telegram-questions.json");
	});

	afterEach(() => {
		rmSync(homeDir, { recursive: true, force: true });
	});

	test("forward → button tap via poller → answerQuestion called → messages deleted", async () => {
		const transport = makeTransport();
		const store = new TelegramQuestionStore(storePath);
		const settings = makeSettings();
		const failureState = new TelegramFailureState();
		const calls: Array<[string, string, string]> = [];

		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: () => settings,
			failureState,
			answerQuestion: (wf, qid, ans) => {
				calls.push([wf, qid, ans]);
			},
		});

		await forwarder.forwardQuestion("wf-1", makeQuestion());
		expect(transport.sendCalls).toHaveLength(1);
		const stored = store.getByQuestionId("q-1");
		expect(stored).not.toBeNull();
		const sentMessageId = stored?.messageIds[0] as number;

		const poller = new TelegramUpdatePoller({
			transport,
			getSettings: () => settings,
			failureState,
			forwarder,
			sleep: async () => {},
		});

		// Enqueue a callback_query as if user tapped option B.
		transport.enqueueUpdates([
			{
				updateId: 1,
				callbackQuery: {
					id: "cb-1",
					chatId: "@chat",
					data: "q:q-1:B",
					messageId: null,
				},
			},
		]);

		poller.start();
		// Wait briefly for the poll to consume the queued batch.
		await new Promise((r) => setTimeout(r, 200));
		await poller.stop();

		expect(calls).toEqual([["wf-1", "q-1", "B"]]);
		expect(transport.deleteCalls).toHaveLength(1);
		expect(transport.deleteCalls[0].messageId).toBe(sentMessageId);
		expect(store.getByQuestionId("q-1")).toBeNull();
	});

	test("multi-message question: full group is deleted on answer", async () => {
		const transport = makeTransport();
		const store = new TelegramQuestionStore(storePath);
		const settings = makeSettings();
		const failureState = new TelegramFailureState();
		const calls: Array<[string, string, string]> = [];

		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: () => settings,
			failureState,
			answerQuestion: (wf, qid, ans) => {
				calls.push([wf, qid, ans]);
			},
		});

		// Force a multi-chunk forward.
		const longContent = ["a".repeat(6000), "", "| K | D |", "| --- | --- |", "| A | one |"].join(
			"\n",
		);
		await forwarder.forwardQuestion("wf-1", {
			id: "q-multi",
			content: longContent,
			detectedAt: "2026-05-07T12:00:00.000Z",
		});

		const stored = store.getByQuestionId("q-multi");
		expect(stored).not.toBeNull();
		const expectedDeletes = stored?.messageIds.length ?? 0;
		expect(expectedDeletes).toBeGreaterThanOrEqual(2);

		await forwarder.handleAnswered("wf-1", "q-multi");
		expect(transport.deleteCalls.length).toBe(expectedDeletes);
		expect(store.getByQuestionId("q-multi")).toBeNull();
	});

	test("restart recovery (FR-016 / SC-007): persisted entry survives reload; subsequent button-tap resolves", async () => {
		const transport = makeTransport();
		const settings = makeSettings();
		const failureState = new TelegramFailureState();
		const calls: Array<[string, string, string]> = [];

		// First instance: forward two questions.
		const store1 = new TelegramQuestionStore(storePath);
		store1.loadOnStartup();
		const fwd1 = new TelegramQuestionForwarder({
			transport,
			store: store1,
			getSettings: () => settings,
			failureState,
			answerQuestion: () => {},
		});
		await fwd1.forwardQuestion("wf-1", makeQuestion());
		await fwd1.forwardQuestion("wf-2", { ...makeQuestion(), id: "q-2" });

		// Simulate restart by re-instantiating store + forwarder from disk.
		const store2 = new TelegramQuestionStore(storePath);
		store2.loadOnStartup();
		expect(store2.all()).toHaveLength(2);

		const fwd2 = new TelegramQuestionForwarder({
			transport,
			store: store2,
			getSettings: () => settings,
			failureState,
			answerQuestion: (wf, qid, ans) => {
				calls.push([wf, qid, ans]);
			},
		});

		// Find the callback_data for q-2 by inspecting what was sent (after
		// reload we don't keep the original keyboard, so we use the well-known
		// `q:<id>:<key>` pattern).
		await fwd2.handleInboundCallback("cb-2", "q:q-2:A", null);
		expect(calls).toEqual([["wf-2", "q-2", "A"]]);
		expect(store2.getByQuestionId("q-2")).toBeNull();
		// q-1 still pending.
		expect(store2.getByQuestionId("q-1")).not.toBeNull();
	});

	test("abort path: forwarded question is deleted from chat", async () => {
		const transport = makeTransport();
		const store = new TelegramQuestionStore(storePath);
		const settings = makeSettings();
		const failureState = new TelegramFailureState();
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: () => settings,
			failureState,
			answerQuestion: () => {},
		});

		await forwarder.forwardQuestion("wf-1", makeQuestion());
		const stored = store.getByQuestionId("q-1");
		expect(stored).not.toBeNull();

		await forwarder.handleAborted("wf-1", "q-1");
		expect(transport.deleteCalls.map((c) => c.messageId)).toEqual(stored?.messageIds ?? []);
		expect(store.getByQuestionId("q-1")).toBeNull();
	});
});
