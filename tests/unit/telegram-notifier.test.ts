import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelegramSettings } from "../../src/config-types";
import { setLitusHome } from "../../src/litus-paths";
import { TelegramFailureState } from "../../src/telegram/telegram-failure-state";
import { TelegramNotifier } from "../../src/telegram/telegram-notifier";
import type {
	TelegramRequest,
	TelegramResponse,
	TelegramTransport,
} from "../../src/telegram/telegram-transport";
import type { Alert } from "../../src/types";

function makeAlert(overrides: Partial<Alert> = {}): Alert {
	return {
		id: "alert_test_0001",
		type: "workflow-finished",
		title: "Build feature X",
		description: "All tests passed.",
		workflowId: "wf_abc",
		epicId: null,
		targetRoute: "/workflow/wf_abc",
		createdAt: 1_700_000_000_000,
		seen: false,
		...overrides,
	};
}

function makeSettings(overrides: Partial<TelegramSettings> = {}): TelegramSettings {
	return { botToken: "TOKEN", chatId: "@chat", active: true, ...overrides };
}

interface ScriptedTransport extends TelegramTransport {
	calls: TelegramRequest[];
	responses: TelegramResponse[];
	idx: number;
}

function makeScriptedTransport(responses: TelegramResponse[]): ScriptedTransport {
	const t: ScriptedTransport = {
		calls: [],
		responses,
		idx: 0,
		async send(req: TelegramRequest): Promise<TelegramResponse> {
			t.calls.push(req);
			const r = t.responses[Math.min(t.idx, t.responses.length - 1)];
			t.idx++;
			return r;
		},
	};
	return t;
}

describe("TelegramNotifier", () => {
	let homeDir: string;

	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "tg-notifier-"));
		setLitusHome(homeDir);
	});

	afterEach(() => {
		rmSync(homeDir, { recursive: true, force: true });
	});

	test("does nothing when active=false", async () => {
		const transport = makeScriptedTransport([{ kind: "ok" }]);
		const failureState = new TelegramFailureState();
		const notifier = new TelegramNotifier({
			getSettings: () => makeSettings({ active: false }),
			getBaseUrl: () => "http://localhost:3000",
			transport,
			failureState,
			sleep: async () => {},
		});
		await notifier.notify(makeAlert());
		expect(transport.calls).toHaveLength(0);
	});

	test("does nothing when creds are empty even if active=true", async () => {
		const transport = makeScriptedTransport([{ kind: "ok" }]);
		const failureState = new TelegramFailureState();
		const notifier = new TelegramNotifier({
			getSettings: () => makeSettings({ botToken: "", active: true }),
			getBaseUrl: () => "http://localhost:3000",
			transport,
			failureState,
			sleep: async () => {},
		});
		await notifier.notify(makeAlert());
		expect(transport.calls).toHaveLength(0);
	});

	test("success on first attempt — no retry, transport hit once", async () => {
		const transport = makeScriptedTransport([{ kind: "ok" }]);
		const failureState = new TelegramFailureState();
		const notifier = new TelegramNotifier({
			getSettings: makeSettings,
			getBaseUrl: () => "http://localhost:3000",
			transport,
			failureState,
			sleep: async () => {},
		});
		await notifier.notify(makeAlert());
		expect(transport.calls).toHaveLength(1);
		expect(failureState.getStatus().unacknowledgedCount).toBe(0);
	});

	test("transient 5xx triggers up to 3 attempts with exponential backoff", async () => {
		const sleeps: number[] = [];
		const transport = makeScriptedTransport([
			{
				kind: "error",
				httpStatus: 502,
				errorCode: 502,
				description: "Bad Gateway",
				retryAfterSeconds: null,
			},
			{
				kind: "error",
				httpStatus: 502,
				errorCode: 502,
				description: "Bad Gateway",
				retryAfterSeconds: null,
			},
			{ kind: "ok" },
		]);
		const failureState = new TelegramFailureState();
		const notifier = new TelegramNotifier({
			getSettings: makeSettings,
			getBaseUrl: () => "http://localhost:3000",
			transport,
			failureState,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			baseBackoffMs: 1000,
		});
		await notifier.notify(makeAlert());
		expect(transport.calls).toHaveLength(3);
		expect(sleeps).toEqual([1000, 2000]);
		expect(failureState.getStatus().unacknowledgedCount).toBe(0);
	});

	test("HTTP 429 honors retry_after as a floor", async () => {
		const sleeps: number[] = [];
		const transport = makeScriptedTransport([
			{
				kind: "error",
				httpStatus: 429,
				errorCode: 429,
				description: "Too Many",
				retryAfterSeconds: 7,
			},
			{ kind: "ok" },
		]);
		const failureState = new TelegramFailureState();
		const notifier = new TelegramNotifier({
			getSettings: makeSettings,
			getBaseUrl: () => "http://localhost:3000",
			transport,
			failureState,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			baseBackoffMs: 1000,
		});
		await notifier.notify(makeAlert());
		expect(transport.calls).toHaveLength(2);
		// First sleep should be max(1000, 7000) = 7000
		expect(sleeps[0]).toBe(7000);
	});

	test("non-retryable 4xx fails fast (single attempt) and records failure", async () => {
		const transport = makeScriptedTransport([
			{
				kind: "error",
				httpStatus: 401,
				errorCode: 401,
				description: "Unauthorized",
				retryAfterSeconds: null,
			},
		]);
		const failureState = new TelegramFailureState();
		const notifier = new TelegramNotifier({
			getSettings: makeSettings,
			getBaseUrl: () => "http://localhost:3000",
			transport,
			failureState,
			sleep: async () => {},
		});
		await notifier.notify(makeAlert());
		expect(transport.calls).toHaveLength(1);
		const status = failureState.getStatus();
		expect(status.unacknowledgedCount).toBe(1);
		expect(status.lastFailureReason).toContain("HTTP 401");
		expect(status.lastFailureReason).toContain("Unauthorized");
	});

	test("exhausted retries record a single failure entry", async () => {
		const transport = makeScriptedTransport([
			{ kind: "error", httpStatus: 500, errorCode: 500, description: "x", retryAfterSeconds: null },
			{ kind: "error", httpStatus: 500, errorCode: 500, description: "x", retryAfterSeconds: null },
			{ kind: "error", httpStatus: 500, errorCode: 500, description: "x", retryAfterSeconds: null },
		]);
		const failureState = new TelegramFailureState();
		const notifier = new TelegramNotifier({
			getSettings: makeSettings,
			getBaseUrl: () => "http://localhost:3000",
			transport,
			failureState,
			sleep: async () => {},
		});
		await notifier.notify(makeAlert());
		expect(transport.calls).toHaveLength(3);
		expect(failureState.getStatus().unacknowledgedCount).toBe(1);
	});

	test("notify never throws even if transport throws synchronously", async () => {
		const failureState = new TelegramFailureState();
		const transport: TelegramTransport = {
			send() {
				throw new Error("boom");
			},
		};
		const notifier = new TelegramNotifier({
			getSettings: makeSettings,
			getBaseUrl: () => "http://localhost:3000",
			transport,
			failureState,
			sleep: async () => {},
		});
		// Should resolve without rejecting.
		await notifier.notify(makeAlert());
		expect(failureState.getStatus().unacknowledgedCount).toBe(1);
	});

	test("network-error response is retried and clears failure state on success", async () => {
		const sleeps: number[] = [];
		const transport = makeScriptedTransport([
			{
				kind: "error",
				httpStatus: null,
				errorCode: null,
				description: "network: connect ETIMEDOUT",
				retryAfterSeconds: null,
			},
			{ kind: "ok" },
		]);
		const failureState = new TelegramFailureState();
		const notifier = new TelegramNotifier({
			getSettings: makeSettings,
			getBaseUrl: () => "http://localhost:3000",
			transport,
			failureState,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			baseBackoffMs: 1000,
		});
		await notifier.notify(makeAlert());
		expect(transport.calls).toHaveLength(2);
		expect(sleeps).toEqual([1000]);
		expect(failureState.getStatus().unacknowledgedCount).toBe(0);
	});

	test("audit log records success and final failure entries on disk", async () => {
		const okTransport = makeScriptedTransport([{ kind: "ok" }]);
		const failureState = new TelegramFailureState();
		const okNotifier = new TelegramNotifier({
			getSettings: makeSettings,
			getBaseUrl: () => "http://localhost:3000",
			transport: okTransport,
			failureState,
			sleep: async () => {},
		});
		await okNotifier.notify(makeAlert({ id: "alert_ok_1" }));

		const failTransport = makeScriptedTransport([
			{
				kind: "error",
				httpStatus: 401,
				errorCode: 401,
				description: "Unauthorized",
				retryAfterSeconds: null,
			},
		]);
		const failNotifier = new TelegramNotifier({
			getSettings: makeSettings,
			getBaseUrl: () => "http://localhost:3000",
			transport: failTransport,
			failureState,
			sleep: async () => {},
		});
		await failNotifier.notify(makeAlert({ id: "alert_fail_1" }));

		const auditPath = join(homeDir, "audit", "telegram-deliveries.jsonl");
		const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const success = JSON.parse(lines[0]);
		expect(success).toMatchObject({
			kind: "success",
			alertId: "alert_ok_1",
			alertType: "workflow-finished",
			attempts: 1,
		});
		expect(typeof success.timestamp).toBe("string");
		const failure = JSON.parse(lines[1]);
		expect(failure).toMatchObject({
			kind: "failure",
			alertId: "alert_fail_1",
			attempts: 1,
			errorCode: 401,
		});
		expect(failure.reason).toContain("HTTP 401");
	});

	test("alerts are dispatched serially in order", async () => {
		const order: string[] = [];
		const transport: TelegramTransport = {
			async send(req) {
				order.push(req.text);
				await new Promise((r) => setTimeout(r, 5));
				return { kind: "ok" };
			},
		};
		const failureState = new TelegramFailureState();
		const notifier = new TelegramNotifier({
			getSettings: makeSettings,
			getBaseUrl: () => "http://localhost:3000",
			transport,
			failureState,
			sleep: async () => {},
		});
		const a1 = notifier.notify(makeAlert({ id: "a1", title: "FIRST" }));
		const a2 = notifier.notify(makeAlert({ id: "a2", title: "SECOND" }));
		await Promise.all([a1, a2]);
		expect(order[0]).toContain("FIRST");
		expect(order[1]).toContain("SECOND");
	});
});
