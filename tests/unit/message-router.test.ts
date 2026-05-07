import { describe, expect, test } from "bun:test";
import { MessageRouter } from "../../src/server/message-router";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../test-infra/mock-websocket";

function setup() {
	const router = new MessageRouter();
	const { mock: ws } = createMockWebSocket();
	// `createMockWebSocket` defaults `data.helloReceived = true`, so
	// these dispatches start past the version-handshake gate. Handshake
	// behavior has its own dedicated tests.
	const { deps, sentMessages } = createMockHandlerDeps();
	return { router, ws: ws as unknown as Parameters<typeof router.dispatch>[0], deps, sentMessages };
}

describe("MessageRouter", () => {
	test("dispatches to registered handler", () => {
		const { router, ws, deps } = setup();
		let called = false;

		router.register("alert:list", (_ws, data, _deps) => {
			called = true;
			expect((data as { type: string }).type).toBe("alert:list");
		});

		router.dispatch(ws, JSON.stringify({ type: "alert:list" }), deps);
		expect(called).toBe(true);
	});

	test("sends typed schema_violation error for unknown message type", () => {
		const { router, ws, deps, sentMessages } = setup();

		router.dispatch(ws, JSON.stringify({ type: "nonexistent" }), deps);

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		const err = msgs[0] as { type: string; code?: string; message: string };
		expect(err.type).toBe("error");
		expect(err.code).toBe("schema_violation");
	});

	test("sends typed schema_violation error for malformed JSON", () => {
		const { router, ws, deps, sentMessages } = setup();

		router.dispatch(ws, "not valid json{{{", deps);

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		const err = msgs[0] as { type: string; code?: string };
		expect(err.type).toBe("error");
		expect(err.code).toBe("schema_violation");
	});

	test("sends typed schema_violation error for message without type field", () => {
		const { router, ws, deps, sentMessages } = setup();

		router.dispatch(ws, JSON.stringify({ foo: "bar" }), deps);

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		const err = msgs[0] as { type: string; code?: string };
		expect(err.type).toBe("error");
		expect(err.code).toBe("schema_violation");
	});

	test("sends typed schema_violation error for non-object message", () => {
		const { router, ws, deps, sentMessages } = setup();

		router.dispatch(ws, JSON.stringify("just a string"), deps);

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		const err = msgs[0] as { type: string; code?: string };
		expect(err.type).toBe("error");
		expect(err.code).toBe("schema_violation");
	});

	test("sends typed schema_violation when known type has missing required field", () => {
		const { router, ws, deps, sentMessages } = setup();
		// `workflow:abort` requires workflowId; omit it.
		router.dispatch(ws, JSON.stringify({ type: "workflow:abort" }), deps);

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		const err = msgs[0] as { type: string; code?: string };
		expect(err.type).toBe("error");
		expect(err.code).toBe("schema_violation");
	});

	test("catches sync errors from handlers", () => {
		const { router, ws, deps, sentMessages } = setup();

		router.register("alert:list", () => {
			throw new Error("sync boom");
		});

		router.dispatch(ws, JSON.stringify({ type: "alert:list" }), deps);

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		const err = msgs[0] as { type: string; code?: string; message: string };
		expect(err.type).toBe("error");
		expect(err.code).toBe("internal");
		expect(err.message).toBe("sync boom");
	});

	test("catches async errors from handlers", async () => {
		const { router, ws, deps, sentMessages } = setup();

		router.register("alert:list", async () => {
			throw new Error("async boom");
		});

		router.dispatch(ws, JSON.stringify({ type: "alert:list" }), deps);

		await new Promise((r) => setTimeout(r, 10));

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		const err = msgs[0] as { type: string; code?: string; message: string };
		expect(err.type).toBe("error");
		expect(err.code).toBe("internal");
		expect(err.message).toBe("async boom");
	});

	test("passes correct ws, data, and deps to handler", () => {
		const { router, ws, deps } = setup();
		let receivedWs: unknown;
		let receivedData: unknown;
		let receivedDeps: unknown;

		router.register("workflow:abort", (w, d, dp) => {
			receivedWs = w;
			receivedData = d;
			receivedDeps = dp;
		});

		router.dispatch(ws, JSON.stringify({ type: "workflow:abort", workflowId: "wf_1" }), deps);

		expect(receivedWs).toBe(ws);
		expect(receivedData).toEqual({ type: "workflow:abort", workflowId: "wf_1" });
		expect(receivedDeps).toBe(deps);
	});

	test("handles Buffer input", () => {
		const { router, ws, deps } = setup();
		let called = false;

		router.register("alert:list", () => {
			called = true;
		});

		router.dispatch(ws, Buffer.from(JSON.stringify({ type: "alert:list" })), deps);
		expect(called).toBe(true);
	});

	test("emits message_too_large error for >1MB frames", () => {
		const { router, ws, deps, sentMessages } = setup();
		const huge = "x".repeat(1_000_001);
		router.dispatch(
			ws,
			JSON.stringify({ type: "client:warning", source: "x", message: huge }),
			deps,
		);

		const msgs = sentMessages.get(ws) ?? [];
		expect(msgs).toHaveLength(1);
		const err = msgs[0] as { type: string; code?: string };
		expect(err.type).toBe("error");
		expect(err.code).toBe("message_too_large");
	});
});
