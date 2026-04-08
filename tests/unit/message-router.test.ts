import { describe, expect, test } from "bun:test";
import { MessageRouter } from "../../src/server/message-router";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

function setup() {
	const router = new MessageRouter();
	const { mock: ws } = createMockWebSocket();
	const { deps, sentMessages } = createMockHandlerDeps();
	return { router, ws: ws as unknown as Parameters<typeof router.dispatch>[0], deps, sentMessages };
}

describe("MessageRouter", () => {
	test("dispatches to registered handler", () => {
		const { router, ws, deps } = setup();
		let called = false;

		router.register("test:action", (_ws, data, _deps) => {
			called = true;
			expect((data as { type: string }).type).toBe("test:action");
		});

		router.dispatch(ws, JSON.stringify({ type: "test:action" }), deps);
		expect(called).toBe(true);
	});

	test("sends error for unknown message type", () => {
		const { router, ws, deps, sentMessages } = setup();

		router.dispatch(ws, JSON.stringify({ type: "nonexistent" }), deps);

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({
			type: "error",
			message: "Unknown message type: nonexistent",
		});
	});

	test("sends error for malformed JSON", () => {
		const { router, ws, deps, sentMessages } = setup();

		router.dispatch(ws, "not valid json{{{", deps);

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({
			type: "error",
			message: "Invalid message format",
		});
	});

	test("sends error for message without type field", () => {
		const { router, ws, deps, sentMessages } = setup();

		router.dispatch(ws, JSON.stringify({ foo: "bar" }), deps);

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({
			type: "error",
			message: "Invalid message format",
		});
	});

	test("sends error for non-object message", () => {
		const { router, ws, deps, sentMessages } = setup();

		router.dispatch(ws, JSON.stringify("just a string"), deps);

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({
			type: "error",
			message: "Invalid message format",
		});
	});

	test("catches sync errors from handlers", () => {
		const { router, ws, deps, sentMessages } = setup();

		router.register("test:throw", () => {
			throw new Error("sync boom");
		});

		router.dispatch(ws, JSON.stringify({ type: "test:throw" }), deps);

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({
			type: "error",
			message: "sync boom",
		});
	});

	test("catches async errors from handlers", async () => {
		const { router, ws, deps, sentMessages } = setup();

		router.register("test:async-throw", async () => {
			throw new Error("async boom");
		});

		router.dispatch(ws, JSON.stringify({ type: "test:async-throw" }), deps);

		// Allow the promise rejection to be caught
		await new Promise((r) => setTimeout(r, 10));

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({
			type: "error",
			message: "async boom",
		});
	});

	test("passes correct ws, data, and deps to handler", () => {
		const { router, ws, deps } = setup();
		let receivedWs: unknown;
		let receivedData: unknown;
		let receivedDeps: unknown;

		router.register("test:check", (w, d, dp) => {
			receivedWs = w;
			receivedData = d;
			receivedDeps = dp;
		});

		router.dispatch(ws, JSON.stringify({ type: "test:check", extra: 42 }), deps);

		expect(receivedWs).toBe(ws);
		expect(receivedData).toEqual({ type: "test:check", extra: 42 });
		expect(receivedDeps).toBe(deps);
	});

	test("handles Buffer input", () => {
		const { router, ws, deps } = setup();
		let called = false;

		router.register("test:buffer", () => {
			called = true;
		});

		router.dispatch(ws, Buffer.from(JSON.stringify({ type: "test:buffer" })), deps);
		expect(called).toBe(true);
	});
});
