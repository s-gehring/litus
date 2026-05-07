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
	TelegramRequest,
	TelegramSendResponse,
	TelegramTransport,
} from "../../src/telegram/telegram-transport";
import type { Question } from "../../src/types";

interface RecordingTransport extends TelegramTransport {
	sendCalls: TelegramRequest[];
	deleteCalls: DeleteMessageRequest[];
	answerCalls: AnswerCallbackQueryRequest[];
	sendResponses: TelegramSendResponse[];
	deleteResponses: DeleteMessageResponse[];
}

function makeTransport(
	sendResponses: TelegramSendResponse[] = [],
	deleteResponses: DeleteMessageResponse[] = [],
): RecordingTransport {
	const t: RecordingTransport = {
		sendCalls: [],
		deleteCalls: [],
		answerCalls: [],
		sendResponses,
		deleteResponses,
		async send(req: TelegramRequest): Promise<TelegramSendResponse> {
			t.sendCalls.push(req);
			return t.sendResponses.shift() ?? { kind: "ok", messageId: 1000 + t.sendCalls.length };
		},
		async deleteMessage(req: DeleteMessageRequest): Promise<DeleteMessageResponse> {
			t.deleteCalls.push(req);
			return t.deleteResponses.shift() ?? { kind: "ok" };
		},
		async answerCallbackQuery(req: AnswerCallbackQueryRequest): Promise<DeleteMessageResponse> {
			t.answerCalls.push(req);
			return { kind: "ok" };
		},
		async getUpdates(): Promise<GetUpdatesResponse> {
			return { kind: "ok", updates: [] };
		},
	};
	return t;
}

function makeSettings(over: Partial<TelegramSettings> = {}): TelegramSettings {
	return {
		botToken: "TOK",
		chatId: "@chat",
		active: true,
		forwardQuestions: true,
		...over,
	};
}

function makeQuestion(over: Partial<Question> = {}): Question {
	return {
		id: "q-uuid-1",
		content: [
			"Pick one:",
			"",
			"| Key | Description |",
			"| --- | --- |",
			"| A | First |",
			"| B | Second |",
		].join("\n"),
		detectedAt: "2026-05-07T12:00:00.000Z",
		...over,
	};
}

describe("TelegramQuestionForwarder", () => {
	let homeDir: string;
	let storePath: string;

	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "tg-forwarder-"));
		setLitusHome(homeDir);
		storePath = join(homeDir, "telegram-questions.json");
	});

	afterEach(() => {
		rmSync(homeDir, { recursive: true, force: true });
	});

	test("does nothing when forwardQuestions is off", async () => {
		const transport = makeTransport();
		const store = new TelegramQuestionStore(storePath);
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: () => makeSettings({ forwardQuestions: false }),
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion());
		expect(transport.sendCalls).toHaveLength(0);
		expect(store.all()).toHaveLength(0);
	});

	test("does nothing when active is off (even with forwardQuestions on)", async () => {
		const transport = makeTransport();
		const store = new TelegramQuestionStore(storePath);
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: () => makeSettings({ active: false }),
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion());
		expect(transport.sendCalls).toHaveLength(0);
	});

	test("forward happy path: sends one message with inline keyboard, persists store entry", async () => {
		const transport = makeTransport([{ kind: "ok", messageId: 7777 }]);
		const store = new TelegramQuestionStore(storePath);
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion());

		expect(transport.sendCalls).toHaveLength(1);
		expect(transport.sendCalls[0].replyMarkup).toBeDefined();
		const keyboard = transport.sendCalls[0].replyMarkup?.inline_keyboard;
		expect(keyboard).toHaveLength(2);
		expect(keyboard?.[0][0].text).toBe("A");
		expect(keyboard?.[0][0].callback_data).toBe("q:q-uuid-1:A");
		expect(store.getByMessageId(7777)?.questionId).toBe("q-uuid-1");
	});

	test("free-form question forwards without keyboard", async () => {
		const transport = makeTransport([{ kind: "ok", messageId: 1 }]);
		const store = new TelegramQuestionStore(storePath);
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion({ content: "Describe yourself" }));
		expect(transport.sendCalls[0].replyMarkup).toBeUndefined();
	});

	test("button-tap path: parses callback, calls answerQuestion with key, deletes message group", async () => {
		const transport = makeTransport([{ kind: "ok", messageId: 100 }]);
		const store = new TelegramQuestionStore(storePath);
		const calls: Array<[string, string, string]> = [];
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: (wf, qid, ans) => {
				calls.push([wf, qid, ans]);
			},
		});

		await forwarder.forwardQuestion("wf-1", makeQuestion());
		await forwarder.handleInboundCallback("cb-1", "q:q-uuid-1:A", null);

		expect(calls).toEqual([["wf-1", "q-uuid-1", "A"]]);
		expect(transport.answerCalls).toHaveLength(1);
		expect(transport.deleteCalls).toHaveLength(1);
		expect(transport.deleteCalls[0].messageId).toBe(100);
		expect(store.getByQuestionId("q-uuid-1")).toBeNull();
	});

	test("answered-elsewhere (frontend answer): deletes message group", async () => {
		const transport = makeTransport([{ kind: "ok", messageId: 50 }]);
		const store = new TelegramQuestionStore(storePath);
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion());
		await forwarder.handleAnswered("wf-1", "q-uuid-1");
		expect(transport.deleteCalls).toHaveLength(1);
		expect(transport.deleteCalls[0].messageId).toBe(50);
		expect(store.getByQuestionId("q-uuid-1")).toBeNull();
	});

	test("quote-reply happy path: delivers verbatim text, deletes message group", async () => {
		const transport = makeTransport([{ kind: "ok", messageId: 200 }]);
		const store = new TelegramQuestionStore(storePath);
		const calls: Array<[string, string, string]> = [];
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: (wf, qid, ans) => {
				calls.push([wf, qid, ans]);
			},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion());
		await forwarder.handleInboundMessage(999, "my custom answer", 200, "@chat");

		expect(calls).toEqual([["wf-1", "q-uuid-1", "my custom answer"]]);
		expect(transport.deleteCalls).toHaveLength(1);
		expect(transport.deleteCalls[0].messageId).toBe(200);
	});

	test("quote-reply on multi-choice question delivers verbatim text (no option-key validation)", async () => {
		const transport = makeTransport([{ kind: "ok", messageId: 300 }]);
		const store = new TelegramQuestionStore(storePath);
		const calls: Array<[string, string, string]> = [];
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: (wf, qid, ans) => {
				calls.push([wf, qid, ans]);
			},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion());
		await forwarder.handleInboundMessage(998, "Z", 300, "@chat");
		expect(calls).toEqual([["wf-1", "q-uuid-1", "Z"]]);
	});

	test("unbound message (no reply-to) sends friendly error and audits unsolicited", async () => {
		const transport = makeTransport();
		const store = new TelegramQuestionStore(storePath);
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
		});
		await forwarder.handleInboundMessage(123, "hi bot", null, "@chat");
		// One outbound friendly-error reply.
		expect(transport.sendCalls).toHaveLength(1);
		expect(transport.sendCalls[0].text).toContain("reply");
	});

	test("reply to an unrelated/unknown message sends the FR-009 use-reply-feature notice", async () => {
		const transport = makeTransport();
		const store = new TelegramQuestionStore(storePath);
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
		});
		await forwarder.handleInboundMessage(123, "Z", 99999, "@chat");
		expect(transport.sendCalls).toHaveLength(1);
		expect(transport.sendCalls[0].text.toLowerCase()).toContain("reply");
		// Should NOT misleadingly tell the user "already answered".
		expect(transport.sendCalls[0].text.toLowerCase()).not.toContain("already");
	});

	test("multi-chunk forward: persists ordered messageIds; quote-reply on any chunk resolves the question", async () => {
		// Build a question whose body exceeds the per-message limit so the
		// forwarder splits it into multiple chunks.
		const longBody = ["a".repeat(5000), "", "| K | D |", "| --- | --- |", "| A | one |"].join("\n");
		const transport = makeTransport([
			{ kind: "ok", messageId: 11 },
			{ kind: "ok", messageId: 12 },
		]);
		const store = new TelegramQuestionStore(storePath);
		const calls: Array<[string, string, string]> = [];
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: (wf, qid, ans) => {
				calls.push([wf, qid, ans]);
			},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion({ id: "q-multi", content: longBody }));

		expect(transport.sendCalls.length).toBeGreaterThanOrEqual(2);
		// Only the LAST chunk carries the keyboard.
		expect(transport.sendCalls[0].replyMarkup).toBeUndefined();
		expect(transport.sendCalls[transport.sendCalls.length - 1].replyMarkup).toBeDefined();

		const stored = store.getByQuestionId("q-multi");
		expect(stored?.messageIds).toEqual([11, 12]);

		// Quote-reply targeting the FIRST chunk resolves the same logical question.
		await forwarder.handleInboundMessage(900, "verbatim", 11, "@chat");
		expect(calls).toEqual([["wf-1", "q-multi", "verbatim"]]);
		// Both chunks deleted.
		expect(transport.deleteCalls.map((c) => c.messageId).sort()).toEqual([11, 12]);
	});

	test("abort path: single-message group is deleted", async () => {
		const transport = makeTransport([{ kind: "ok", messageId: 555 }]);
		const store = new TelegramQuestionStore(storePath);
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion());
		await forwarder.handleAborted("wf-1", "q-uuid-1");
		expect(transport.deleteCalls).toHaveLength(1);
		expect(transport.deleteCalls[0].messageId).toBe(555);
		expect(store.getByQuestionId("q-uuid-1")).toBeNull();
	});

	test("abort path: multi-message group all deleted", async () => {
		const longBody = ["a".repeat(5000), "", "| K | D |", "| --- | --- |", "| A | one |"].join("\n");
		const transport = makeTransport([
			{ kind: "ok", messageId: 21 },
			{ kind: "ok", messageId: 22 },
		]);
		const store = new TelegramQuestionStore(storePath);
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion({ id: "q-multi", content: longBody }));
		await forwarder.handleAborted("wf-1", "q-multi");
		expect(transport.deleteCalls.map((c) => c.messageId).sort()).toEqual([21, 22]);
	});

	test("abort after partial deletion failure: never throws, errors audit-logged", async () => {
		const transport = makeTransport(
			[
				{ kind: "ok", messageId: 31 },
				{ kind: "ok", messageId: 32 },
			],
			[
				{
					kind: "error",
					httpStatus: 400,
					errorCode: 400,
					description: "message to delete not found",
					retryAfterSeconds: null,
				},
				{ kind: "ok" },
			],
		);
		const store = new TelegramQuestionStore(storePath);
		const longBody = ["a".repeat(5000), "", "| K | D |", "| --- | --- |", "| A | one |"].join("\n");
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion({ id: "q-partial", content: longBody }));
		// Should not throw even when first delete fails fatally.
		await forwarder.handleAborted("wf-1", "q-partial");
		// Both delete attempts were issued.
		expect(transport.deleteCalls.length).toBe(2);
	});

	test("FR-014 deleteMessage retries on 429 then succeeds", async () => {
		const transport = makeTransport(
			[{ kind: "ok", messageId: 700 }],
			[
				{
					kind: "error",
					httpStatus: 429,
					errorCode: 429,
					description: "Too Many Requests",
					retryAfterSeconds: 0,
				},
				{ kind: "ok" },
			],
		);
		const store = new TelegramQuestionStore(storePath);
		const sleeps: number[] = [];
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion());
		await forwarder.handleAnswered("wf-1", "q-uuid-1");
		expect(transport.deleteCalls).toHaveLength(2);
		expect(sleeps.length).toBeGreaterThanOrEqual(1);
	});

	test("FR-014 deleteMessage gives up after 3 retryable failures", async () => {
		const transport = makeTransport(
			[{ kind: "ok", messageId: 800 }],
			[
				{
					kind: "error",
					httpStatus: 500,
					errorCode: null,
					description: "boom",
					retryAfterSeconds: null,
				},
				{
					kind: "error",
					httpStatus: 500,
					errorCode: null,
					description: "boom",
					retryAfterSeconds: null,
				},
				{
					kind: "error",
					httpStatus: 500,
					errorCode: null,
					description: "boom",
					retryAfterSeconds: null,
				},
			],
		);
		const store = new TelegramQuestionStore(storePath);
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
			sleep: async () => {},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion());
		await forwarder.handleAnswered("wf-1", "q-uuid-1");
		// 1 immediate + 2 retries = 3 attempts.
		expect(transport.deleteCalls).toHaveLength(3);
	});

	test("stale callback with messageId issues best-effort delete (FR-015)", async () => {
		const transport = makeTransport();
		const store = new TelegramQuestionStore(storePath);
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState: new TelegramFailureState(),
			answerQuestion: () => {},
			sleep: async () => {},
		});
		// No store entry — entirely stale.
		await forwarder.handleInboundCallback("cb-stale", "q:gone:A", 4242);
		expect(transport.answerCalls).toHaveLength(1);
		expect(transport.answerCalls[0].text).toContain("already");
		expect(transport.deleteCalls).toHaveLength(1);
		expect(transport.deleteCalls[0].messageId).toBe(4242);
	});

	test("forward failure (401) is logged and no store entry persisted", async () => {
		const transport = makeTransport([
			{
				kind: "error",
				httpStatus: 401,
				errorCode: 401,
				description: "Unauthorized",
				retryAfterSeconds: null,
			},
		]);
		const store = new TelegramQuestionStore(storePath);
		const failureState = new TelegramFailureState();
		const forwarder = new TelegramQuestionForwarder({
			transport,
			store,
			getSettings: makeSettings,
			failureState,
			answerQuestion: () => {},
		});
		await forwarder.forwardQuestion("wf-1", makeQuestion());
		expect(store.all()).toHaveLength(0);
		expect(failureState.getStatus().unacknowledgedCount).toBe(1);
	});
});
