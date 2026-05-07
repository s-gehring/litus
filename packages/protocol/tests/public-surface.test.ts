// Public-surface lock-in (T021, US1 acceptance #2).
//
// Type-level fixture asserting the package exports every name listed in
// FR-005 with the expected shape. Compile-time only: a missing or
// renamed export fails `bun run tsc --noEmit` (and therefore CI).

import { describe, expect, test } from "bun:test";
import {
	type Channel,
	CLOSE_CODE_PROTOCOL,
	type ClientMessage,
	channelSchema,
	clientMessageSchema,
	DELTA_FLUSH_TIMEOUT_MS,
	errorCodeSchema,
	errorFrameSchema,
	PROTOCOL_VERSION,
	protocolVersionSchema,
	type ServerMessage,
	type StateChange,
	type StateChangeAction,
	type StateChangeListener,
	type StateChangeScope,
	serverMessageSchema,
	TELEGRAM_TOKEN_SENTINEL,
	validateOutgoingInDev,
} from "../src/index";

// Type-fixture vars: if any of these names disappear or change shape,
// this file stops compiling. Compile-time guard, not a runtime check.
const _serverMsg: ServerMessage = { type: "console:output", text: "x" };
const _clientMsg: ClientMessage = { type: "alert:list" };
const _change: StateChange = { scope: { entity: "global" }, action: "updated" };
const _action: StateChangeAction = "appended";
const _scope: StateChangeScope = { entity: "none" };
const _listener: StateChangeListener = () => {};
const _channel: Channel = { kind: "console" };
void _serverMsg;
void _clientMsg;
void _change;
void _action;
void _scope;
void _listener;
void _channel;

describe("public surface", () => {
	test("constants have expected runtime values", () => {
		expect(DELTA_FLUSH_TIMEOUT_MS).toBe(50);
		expect(TELEGRAM_TOKEN_SENTINEL).toBe("***configured***");
		expect(CLOSE_CODE_PROTOCOL).toBe(4001);
		expect(PROTOCOL_VERSION).toEqual({ major: 1, minor: 0 });
	});

	test("schemas are exported and parseable", () => {
		expect(typeof serverMessageSchema.parse).toBe("function");
		expect(typeof clientMessageSchema.parse).toBe("function");
		expect(typeof channelSchema.parse).toBe("function");
		expect(typeof errorFrameSchema.parse).toBe("function");
		expect(typeof errorCodeSchema.parse).toBe("function");
		expect(typeof protocolVersionSchema.parse).toBe("function");
	});

	test("validateOutgoingInDev is a function", () => {
		expect(typeof validateOutgoingInDev).toBe("function");
	});
});
