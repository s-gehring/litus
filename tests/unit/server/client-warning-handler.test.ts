import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { handleClientWarning } from "../../../src/server/client-warning-handler";
import type { ClientMessage } from "../../../src/types";
import { createMockHandlerDeps } from "../../test-infra/mock-handler-deps";
import { createMockWebSocket } from "../../test-infra/mock-websocket";

describe("handleClientWarning", () => {
	let warnSpy: ReturnType<typeof mock>;
	let originalWarn: typeof console.warn;

	beforeEach(() => {
		originalWarn = console.warn;
		warnSpy = mock(() => {});
		console.warn = warnSpy as unknown as typeof console.warn;
	});

	afterEach(() => {
		console.warn = originalWarn;
	});

	test("logs the warning server-side using logger.warn", () => {
		const { mock: ws } = createMockWebSocket();
		const { deps } = createMockHandlerDeps();

		const msg: ClientMessage = {
			type: "client:warning",
			source: "workflow",
			message: "workflow:state for unknown workflowId 'wf-123'",
		};
		handleClientWarning(ws as unknown as Parameters<typeof handleClientWarning>[0], msg, deps);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const call = warnSpy.mock.calls[0] as unknown[];
		const printed = call.slice(1).join(" ");
		expect(printed).toContain("[client:workflow]");
		expect(printed).toContain("workflow:state for unknown workflowId 'wf-123'");
	});

	test("does not broadcast the warning back to clients", () => {
		const { mock: ws } = createMockWebSocket();
		const { deps, broadcastedMessages, sentMessages } = createMockHandlerDeps();

		handleClientWarning(
			ws as unknown as Parameters<typeof handleClientWarning>[0],
			{ type: "client:warning", source: "epic", message: "epic:summary unknown epic" },
			deps,
		);

		expect(broadcastedMessages).toHaveLength(0);
		expect(sentMessages.size).toBe(0);
	});
});
