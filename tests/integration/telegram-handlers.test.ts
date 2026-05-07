import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, TELEGRAM_TOKEN_SENTINEL } from "../../src/config-store";
import { auditDir, setLitusHome } from "../../src/litus-paths";
import type { ClientMessage, ServerMessage } from "../../src/protocol";
import { handleConfigSave } from "../../src/server/config-handlers";
import {
	clearTelegramHandlerDeps,
	handleTelegramTest,
	setTelegramHandlerDeps,
} from "../../src/server/telegram-handlers";
import { TelegramFailureState } from "../../src/telegram/telegram-failure-state";
import type {
	TelegramRequest,
	TelegramSendResponse,
	TelegramTransport,
} from "../../src/telegram/telegram-transport";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "telegram-handlers-test-"));
}

describe("config:save — telegram section (US1 contract scenarios 6 & 7)", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("scenario 6: sentinel save accepted and broadcast carries the masked sentinel", () => {
		const realStore = new ConfigStore(join(dir, "config.json"));
		// Seed the store with a real token while inactive.
		expect(
			realStore.save({
				telegram: { botToken: "real-secret-token", chatId: "@x", active: false },
			}).errors,
		).toHaveLength(0);

		const { mock: ws } = createMockWebSocket();
		const mockWs = ws as unknown as Parameters<typeof handleConfigSave>[0];
		const { deps, broadcastedMessages, sentMessages } = createMockHandlerDeps({
			configStore: realStore as unknown as Parameters<typeof handleConfigSave>[2]["configStore"],
		});

		handleConfigSave(
			mockWs,
			{
				type: "config:save",
				config: {
					telegram: { botToken: TELEGRAM_TOKEN_SENTINEL, chatId: "@x", active: true },
				},
			} as ClientMessage,
			deps,
		);

		// No config:error; broadcast carries config:state with the masked sentinel.
		expect((sentMessages.get(mockWs) ?? []).some((m) => m.type === "config:error")).toBe(false);
		const broadcasts = broadcastedMessages.filter(
			(m): m is Extract<ServerMessage, { type: "config:state" }> => m.type === "config:state",
		);
		expect(broadcasts).toHaveLength(1);
		expect(broadcasts[0].config.telegram.botToken).toBe(TELEGRAM_TOKEN_SENTINEL);
		expect(broadcasts[0].config.telegram.chatId).toBe("@x");
		expect(broadcasts[0].config.telegram.active).toBe(true);

		// And the underlying store still has the real token.
		expect(realStore.get().telegram.botToken).toBe("real-secret-token");
	});

	test("scenario 7: active=true with empty botToken returns config:error on telegram.botToken", () => {
		const realStore = new ConfigStore(join(dir, "config.json"));

		const { mock: ws } = createMockWebSocket();
		const mockWs = ws as unknown as Parameters<typeof handleConfigSave>[0];
		const { deps, sentMessages, broadcastedMessages } = createMockHandlerDeps({
			configStore: realStore as unknown as Parameters<typeof handleConfigSave>[2]["configStore"],
		});

		handleConfigSave(
			mockWs,
			{
				type: "config:save",
				config: {
					telegram: { botToken: "", chatId: "@x", active: true },
				},
			} as ClientMessage,
			deps,
		);

		const errs = (sentMessages.get(mockWs) ?? []).filter(
			(m): m is Extract<ServerMessage, { type: "config:error" }> => m.type === "config:error",
		);
		expect(errs).toHaveLength(1);
		expect(errs[0].errors.some((e) => e.path === "telegram.botToken")).toBe(true);
		// No broadcast on error.
		expect(broadcastedMessages.some((m) => m.type === "config:state")).toBe(false);
	});

	test("config:save with forwardQuestions=true round-trips through config:state", () => {
		const realStore = new ConfigStore(join(dir, "config.json"));
		const { mock: ws } = createMockWebSocket();
		const mockWs = ws as unknown as Parameters<typeof handleConfigSave>[0];
		const { deps, broadcastedMessages, sentMessages } = createMockHandlerDeps({
			configStore: realStore as unknown as Parameters<typeof handleConfigSave>[2]["configStore"],
		});

		handleConfigSave(
			mockWs,
			{
				type: "config:save",
				config: { telegram: { forwardQuestions: true } },
			} as ClientMessage,
			deps,
		);

		expect((sentMessages.get(mockWs) ?? []).some((m) => m.type === "config:error")).toBe(false);
		const broadcast = broadcastedMessages.find(
			(m): m is Extract<ServerMessage, { type: "config:state" }> => m.type === "config:state",
		);
		expect(broadcast?.config.telegram.forwardQuestions).toBe(true);
	});

	test("config:state always masks the bot token (never plaintext)", () => {
		const realStore = new ConfigStore(join(dir, "config.json"));
		expect(
			realStore.save({
				telegram: { botToken: "plaintext-token", chatId: "@x", active: false },
			}).errors,
		).toHaveLength(0);

		const { mock: ws } = createMockWebSocket();
		const mockWs = ws as unknown as Parameters<typeof handleConfigSave>[0];
		const { deps, broadcastedMessages } = createMockHandlerDeps({
			configStore: realStore as unknown as Parameters<typeof handleConfigSave>[2]["configStore"],
		});

		handleConfigSave(
			mockWs,
			{
				type: "config:save",
				config: { telegram: { active: false } },
			} as ClientMessage,
			deps,
		);

		const broadcast = broadcastedMessages.find(
			(m): m is Extract<ServerMessage, { type: "config:state" }> => m.type === "config:state",
		);
		expect(broadcast?.config.telegram.botToken).toBe(TELEGRAM_TOKEN_SENTINEL);
		expect(JSON.stringify(broadcast)).not.toContain("plaintext-token");
	});
});

interface ScriptedTransport extends TelegramTransport {
	calls: TelegramRequest[];
	response: TelegramSendResponse;
}

function makeScriptedTransport(response: TelegramSendResponse): ScriptedTransport {
	const t: ScriptedTransport = {
		calls: [],
		response,
		async send(req) {
			t.calls.push(req);
			return t.response;
		},
		async deleteMessage() {
			return { kind: "ok" };
		},
		async answerCallbackQuery() {
			return { kind: "ok" };
		},
		async getUpdates() {
			return { kind: "ok", updates: [] };
		},
	};
	return t;
}

describe("telegram:test handler (US3 contract scenarios 1–4)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "telegram-test-handler-"));
		setLitusHome(dir);
	});

	afterEach(() => {
		clearTelegramHandlerDeps();
		rmSync(dir, { recursive: true, force: true });
	});

	test("scenario 1: empty creds → reason set, transport not called", async () => {
		const transport = makeScriptedTransport({ kind: "ok", messageId: 1 });
		const failureState = new TelegramFailureState();
		const realStore = new ConfigStore(join(dir, "config.json"));

		const { mock: ws } = createMockWebSocket();
		const mockWs = ws as unknown as Parameters<typeof handleTelegramTest>[0];
		const { deps, sentMessages } = createMockHandlerDeps({
			configStore: realStore as unknown as Parameters<typeof handleConfigSave>[2]["configStore"],
		});
		setTelegramHandlerDeps({
			failureState,
			transport,
			configStore: realStore,
			broadcast: deps.broadcast,
			sendTo: deps.sendTo,
		});

		await handleTelegramTest(
			mockWs,
			{ type: "telegram:test", botToken: "", chatId: "" } as ClientMessage,
			deps,
		);

		expect(transport.calls).toHaveLength(0);
		const reply = (sentMessages.get(mockWs) ?? []).find((m) => m.type === "telegram:test-result") as
			| Extract<ServerMessage, { type: "telegram:test-result" }>
			| undefined;
		expect(reply?.ok).toBe(false);
		if (reply && reply.ok === false) {
			// Substring assertion so user-facing wording stays maintainable;
			// see code-review §1.12.
			expect(reply.reason).toContain("required");
		}
	});

	test("scenario 2: sentinel botToken → transport called with stored token, not the sentinel", async () => {
		const transport = makeScriptedTransport({ kind: "ok", messageId: 1 });
		const failureState = new TelegramFailureState();
		const realStore = new ConfigStore(join(dir, "config.json"));
		expect(
			realStore.save({
				telegram: { botToken: "stored-token-xyz", chatId: "@stored", active: false },
			}).errors,
		).toHaveLength(0);

		const { mock: ws } = createMockWebSocket();
		const mockWs = ws as unknown as Parameters<typeof handleTelegramTest>[0];
		const { deps } = createMockHandlerDeps({
			configStore: realStore as unknown as Parameters<typeof handleConfigSave>[2]["configStore"],
		});
		setTelegramHandlerDeps({
			failureState,
			transport,
			configStore: realStore,
			broadcast: deps.broadcast,
			sendTo: deps.sendTo,
		});

		await handleTelegramTest(
			mockWs,
			{
				type: "telegram:test",
				botToken: TELEGRAM_TOKEN_SENTINEL,
				chatId: "@form",
			} as ClientMessage,
			deps,
		);

		expect(transport.calls).toHaveLength(1);
		expect(transport.calls[0].botToken).toBe("stored-token-xyz");
		// The chat id from the form must be honored (the user may want to test
		// against a different chat without committing it).
		expect(transport.calls[0].chatId).toBe("@form");
	});

	test("scenario 3: happy path → transport called once and { ok: true }", async () => {
		const transport = makeScriptedTransport({ kind: "ok", messageId: 1 });
		const failureState = new TelegramFailureState();
		const realStore = new ConfigStore(join(dir, "config.json"));

		const { mock: ws } = createMockWebSocket();
		const mockWs = ws as unknown as Parameters<typeof handleTelegramTest>[0];
		const { deps, sentMessages } = createMockHandlerDeps({
			configStore: realStore as unknown as Parameters<typeof handleConfigSave>[2]["configStore"],
		});
		setTelegramHandlerDeps({
			failureState,
			transport,
			configStore: realStore,
			broadcast: deps.broadcast,
			sendTo: deps.sendTo,
		});

		await handleTelegramTest(
			mockWs,
			{ type: "telegram:test", botToken: "tok", chatId: "@chat" } as ClientMessage,
			deps,
		);

		expect(transport.calls).toHaveLength(1);
		const reply = (sentMessages.get(mockWs) ?? []).find((m) => m.type === "telegram:test-result") as
			| Extract<ServerMessage, { type: "telegram:test-result" }>
			| undefined;
		expect(reply?.ok).toBe(true);
	});

	test("scenario 4: 401 → errorCode 401, no audit write, no failure-state mutation", async () => {
		const transport = makeScriptedTransport({
			kind: "error",
			httpStatus: 401,
			errorCode: 401,
			description: "Unauthorized",
			retryAfterSeconds: null,
		});
		const failureState = new TelegramFailureState();
		const realStore = new ConfigStore(join(dir, "config.json"));

		const { mock: ws } = createMockWebSocket();
		const mockWs = ws as unknown as Parameters<typeof handleTelegramTest>[0];
		const { deps, sentMessages } = createMockHandlerDeps({
			configStore: realStore as unknown as Parameters<typeof handleConfigSave>[2]["configStore"],
		});
		setTelegramHandlerDeps({
			failureState,
			transport,
			configStore: realStore,
			broadcast: deps.broadcast,
			sendTo: deps.sendTo,
		});

		await handleTelegramTest(
			mockWs,
			{ type: "telegram:test", botToken: "bad", chatId: "@chat" } as ClientMessage,
			deps,
		);

		const reply = (sentMessages.get(mockWs) ?? []).find((m) => m.type === "telegram:test-result") as
			| Extract<ServerMessage, { type: "telegram:test-result" }>
			| undefined;
		expect(reply?.ok).toBe(false);
		if (reply && reply.ok === false) {
			expect(reply.errorCode).toBe(401);
		}
		// No audit log should have been touched by the test path.
		const auditPath = join(auditDir(), "telegram-deliveries.jsonl");
		let auditFileExists = true;
		try {
			readFileSync(auditPath);
		} catch {
			auditFileExists = false;
		}
		expect(auditFileExists).toBe(false);
		// Failure-state must remain untouched.
		expect(failureState.getStatus().unacknowledgedCount).toBe(0);
	});
});

describe("telegram:acknowledge handler", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "telegram-ack-handler-"));
		setLitusHome(dir);
	});

	afterEach(() => {
		clearTelegramHandlerDeps();
		rmSync(dir, { recursive: true, force: true });
	});

	test("acknowledge zeros unacknowledgedCount and broadcasts telegram:status", async () => {
		const transport: TelegramTransport = {
			async send() {
				return { kind: "ok", messageId: 1 };
			},
			async deleteMessage() {
				return { kind: "ok" };
			},
			async answerCallbackQuery() {
				return { kind: "ok" };
			},
			async getUpdates() {
				return { kind: "ok", updates: [] };
			},
		};
		const failureState = new TelegramFailureState();
		failureState.recordFailure("a", "boom");
		failureState.recordFailure("b", "kaboom");

		const realStore = new ConfigStore(join(dir, "config.json"));
		const { mock: ws } = createMockWebSocket();
		const mockWs = ws as unknown as Parameters<typeof handleTelegramTest>[0];
		const { deps, broadcastedMessages } = createMockHandlerDeps({
			configStore: realStore as unknown as Parameters<typeof handleConfigSave>[2]["configStore"],
		});
		setTelegramHandlerDeps({
			failureState,
			transport,
			configStore: realStore,
			broadcast: deps.broadcast,
			sendTo: deps.sendTo,
		});

		const { handleTelegramAcknowledge } = await import("../../src/server/telegram-handlers");
		await handleTelegramAcknowledge(
			mockWs,
			{ type: "telegram:acknowledge" } as ClientMessage,
			deps,
		);

		const status = broadcastedMessages.find(
			(m): m is Extract<ServerMessage, { type: "telegram:status" }> => m.type === "telegram:status",
		);
		expect(status?.unacknowledgedCount).toBe(0);
		expect(status?.lastFailureReason).toBe("kaboom");
	});
});
