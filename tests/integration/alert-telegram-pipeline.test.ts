import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertQueue } from "../../src/alert-queue";
import { AlertStore } from "../../src/alert-store";
import type { TelegramSettings } from "../../src/config-types";
import { setLitusHome } from "../../src/litus-paths";
import type { ServerMessage } from "../../src/protocol";
import { createAlertBroadcasters } from "../../src/server/alert-broadcast";
import { TelegramFailureState } from "../../src/telegram/telegram-failure-state";
import { TelegramNotifier } from "../../src/telegram/telegram-notifier";
import type { TelegramRequest, TelegramTransport } from "../../src/telegram/telegram-transport";
import type { Alert } from "../../src/types";

interface StubTransport extends TelegramTransport {
	calls: TelegramRequest[];
}

function makeStubTransport(mode: "ok" | "401" = "ok"): StubTransport {
	const stub: StubTransport = {
		calls: [],
		async send(req) {
			stub.calls.push(req);
			if (mode === "ok") return { kind: "ok", messageId: 1 };
			return {
				kind: "error",
				httpStatus: 401,
				errorCode: 401,
				description: "Unauthorized",
				retryAfterSeconds: null,
			};
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
	return stub;
}

function alertInput(): Omit<Alert, "id" | "createdAt" | "seen"> {
	return {
		type: "workflow-finished",
		title: "Done",
		description: "All steps completed",
		workflowId: "wf_abc",
		epicId: null,
		targetRoute: "/workflow/wf_abc",
	};
}

describe("alert pipeline → TelegramNotifier integration", () => {
	let homeDir: string;
	let alertStoreDir: string;

	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "tg-pipeline-home-"));
		alertStoreDir = mkdtempSync(join(tmpdir(), "tg-pipeline-alerts-"));
		setLitusHome(homeDir);
	});

	afterEach(() => {
		rmSync(homeDir, { recursive: true, force: true });
		rmSync(alertStoreDir, { recursive: true, force: true });
	});

	function buildPipeline(settings: TelegramSettings, transport: StubTransport) {
		const broadcasted: ServerMessage[] = [];
		const broadcast = (msg: ServerMessage) => {
			broadcasted.push(msg);
		};
		const failureState = new TelegramFailureState();
		const notifier = new TelegramNotifier({
			getSettings: () => settings,
			getBaseUrl: () => "http://localhost:3000",
			transport,
			failureState,
			sleep: async () => {},
		});
		// Disable dedup for tests that emit a single alert per case — using
		// MAX_SAFE_INTEGER documents intent rather than picking an arbitrary
		// large millisecond value.
		const queue = new AlertQueue(new AlertStore(alertStoreDir), {
			dedupWindowMs: Number.MAX_SAFE_INTEGER,
		});
		const { emitAlert } = createAlertBroadcasters(queue, broadcast, () => [], {
			onAlertAccepted: (a) => {
				void notifier.notify(a);
			},
		});
		return { emitAlert, broadcasted, transport, failureState, notifier };
	}

	async function flush(notifier: TelegramNotifier): Promise<void> {
		// Wait for every previously-queued dispatch (driven via emitAlert) to
		// settle. `idle()` does not inject a synthetic alert, so transport.calls
		// reflects only real alerts — no need to filter out a flush marker.
		await notifier.idle();
	}

	test("active=true + creds → accepted alert is forwarded with correct payload", async () => {
		const transport = makeStubTransport("ok");
		const settings: TelegramSettings = {
			active: true,
			botToken: "T",
			chatId: "@c",
			forwardQuestions: false,
		};
		const { emitAlert, broadcasted, notifier } = buildPipeline(settings, transport);

		emitAlert(alertInput());
		await flush(notifier);

		const inApp = broadcasted.filter((m) => m.type === "alert:created");
		expect(inApp).toHaveLength(1);
		expect(transport.calls).toHaveLength(1);
		expect(transport.calls[0].chatId).toBe("@c");
		expect(transport.calls[0].text).toContain("Workflow finished");
	});

	test("active=false → in-app alert still broadcast, transport NOT called", async () => {
		const transport = makeStubTransport("ok");
		const settings: TelegramSettings = {
			active: false,
			botToken: "T",
			chatId: "@c",
			forwardQuestions: false,
		};
		const { emitAlert, broadcasted, notifier } = buildPipeline(settings, transport);

		emitAlert(alertInput());
		await flush(notifier);

		expect(broadcasted.filter((m) => m.type === "alert:created")).toHaveLength(1);
		expect(transport.calls).toHaveLength(0);
	});

	test("queue-deduplicated alert is NOT forwarded a second time", async () => {
		const transport = makeStubTransport("ok");
		const settings: TelegramSettings = {
			active: true,
			botToken: "T",
			chatId: "@c",
			forwardQuestions: false,
		};
		// Default-ish window: long enough that the second emission is dedup'd.
		const queue = new AlertQueue(new AlertStore(alertStoreDir), { dedupWindowMs: 60_000 });
		const broadcasted: ServerMessage[] = [];
		const broadcast = (msg: ServerMessage) => {
			broadcasted.push(msg);
		};
		const failureState = new TelegramFailureState();
		const notifier = new TelegramNotifier({
			getSettings: () => settings,
			getBaseUrl: () => "http://localhost:3000",
			transport,
			failureState,
			sleep: async () => {},
		});
		const { emitAlert } = createAlertBroadcasters(queue, broadcast, () => [], {
			onAlertAccepted: (a) => {
				void notifier.notify(a);
			},
		});

		emitAlert(alertInput());
		emitAlert(alertInput());
		await flush(notifier);

		// First alert: forwarded. Second alert: dropped at the queue (not the
		// listener), so the transport sees exactly one call.
		expect(transport.calls).toHaveLength(1);
		expect(transport.calls[0].text).toContain("Workflow finished");
	});

	test("transport rejection (401) does NOT break in-app broadcast", async () => {
		const transport = makeStubTransport("401");
		const settings: TelegramSettings = {
			active: true,
			botToken: "T",
			chatId: "@c",
			forwardQuestions: false,
		};
		const { emitAlert, broadcasted, failureState, notifier } = buildPipeline(settings, transport);

		emitAlert(alertInput());
		await flush(notifier);

		expect(broadcasted.filter((m) => m.type === "alert:created")).toHaveLength(1);
		expect(failureState.getStatus().unacknowledgedCount).toBeGreaterThanOrEqual(1);
	});
});
