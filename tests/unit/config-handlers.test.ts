import { describe, expect, test } from "bun:test";
import type { PipelineOrchestrator } from "../../src/pipeline-orchestrator";
import {
	handleConfigGet,
	handleConfigReset,
	handleConfigSave,
} from "../../src/server/config-handlers";
import type { AppConfig, ClientMessage } from "../../src/types";
import { makeWorkflow } from "../helpers";
import { createMockHandlerDeps } from "../test-infra/mock-handler-deps";
import { createMockConfigStore } from "../test-infra/mock-stores";
import { createMockWebSocket } from "../test-infra/mock-websocket";

function setup() {
	const { mock: ws } = createMockWebSocket();
	const mockWs = ws as unknown as Parameters<typeof handleConfigGet>[0];
	const configMock = createMockConfigStore();
	const { deps, sentMessages, broadcastedMessages } = createMockHandlerDeps({
		configStore: configMock.mock as unknown as typeof deps.configStore,
	});
	return { ws: mockWs, deps, sentMessages, broadcastedMessages, configTracker: configMock.tracker };
}

describe("config-handlers", () => {
	describe("handleConfigGet", () => {
		test("sends current config to requesting client", () => {
			const { ws, deps, sentMessages } = setup();

			handleConfigGet(ws, { type: "config:get" } as ClientMessage, deps);

			const msgs = sentMessages.get(ws) ?? [];
			expect(msgs).toHaveLength(1);
			expect(msgs[0].type).toBe("config:state");
		});
	});

	describe("handleConfigSave", () => {
		test("broadcasts config state on successful save", () => {
			const { ws, deps, broadcastedMessages, configTracker } = setup();

			handleConfigSave(
				ws,
				{
					type: "config:save",
					config: { autoMode: "normal" },
				} as ClientMessage,
				deps,
			);

			const saveCalls = configTracker.calls.filter((c) => c.method === "save");
			expect(saveCalls).toHaveLength(1);
			expect(saveCalls[0].args[0]).toEqual({ autoMode: "normal" });
			expect(broadcastedMessages.some((m) => m.type === "config:state")).toBe(true);
		});

		test("sends error on validation failure", () => {
			const { ws, deps, sentMessages } = setup();
			// Override configStore.save to return errors
			deps.configStore.save = () => ({
				errors: [{ path: "autoMode", message: "invalid", value: "bad" }],
				warnings: [],
			});

			handleConfigSave(
				ws,
				{
					type: "config:save",
					config: { autoMode: "bad" as unknown as AppConfig["autoMode"] },
				} as ClientMessage,
				deps,
			);

			const msgs = sentMessages.get(ws) ?? [];
			expect(msgs.some((m) => m.type === "config:error")).toBe(true);
		});

		test("drains pending questions when autoMode is full-auto", () => {
			const wf = makeWorkflow({
				status: "waiting_for_input",
				pendingQuestion: { id: "q1", content: "What?", detectedAt: new Date().toISOString() },
			});

			const skipCalls: unknown[][] = [];
			const mockOrch = {
				getEngine() {
					return {
						getWorkflow() {
							return wf;
						},
					};
				},
				skipQuestion(...args: unknown[]) {
					skipCalls.push(args);
				},
			} as unknown as PipelineOrchestrator;

			const orchestrators = new Map<string, PipelineOrchestrator>();
			orchestrators.set(wf.id, mockOrch);

			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleConfigSave>[0];
			const { deps } = createMockHandlerDeps({ orchestrators });

			handleConfigSave(
				mockWs,
				{
					type: "config:save",
					config: { autoMode: "full-auto" },
				} as ClientMessage,
				deps,
			);

			expect(skipCalls).toHaveLength(1);
			expect(skipCalls[0]).toEqual([wf.id, "q1"]);
		});

		test("does NOT drain pending questions for manual mode", () => {
			const wf = makeWorkflow({
				status: "waiting_for_input",
				pendingQuestion: { id: "q1", content: "What?", detectedAt: new Date().toISOString() },
			});

			const skipCalls: unknown[][] = [];
			const mockOrch = {
				getEngine() {
					return { getWorkflow: () => wf };
				},
				skipQuestion(...args: unknown[]) {
					skipCalls.push(args);
				},
			} as unknown as PipelineOrchestrator;

			const orchestrators = new Map<string, PipelineOrchestrator>();
			orchestrators.set(wf.id, mockOrch);

			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleConfigSave>[0];
			const { deps } = createMockHandlerDeps({ orchestrators });

			handleConfigSave(
				mockWs,
				{ type: "config:save", config: { autoMode: "manual" } } as ClientMessage,
				deps,
			);

			expect(skipCalls).toHaveLength(0);
		});

		test("does NOT drain pending questions for normal mode", () => {
			const wf = makeWorkflow({
				status: "waiting_for_input",
				pendingQuestion: { id: "q1", content: "What?", detectedAt: new Date().toISOString() },
			});

			const skipCalls: unknown[][] = [];
			const mockOrch = {
				getEngine() {
					return { getWorkflow: () => wf };
				},
				skipQuestion(...args: unknown[]) {
					skipCalls.push(args);
				},
			} as unknown as PipelineOrchestrator;

			const orchestrators = new Map<string, PipelineOrchestrator>();
			orchestrators.set(wf.id, mockOrch);

			const { mock: ws } = createMockWebSocket();
			const mockWs = ws as unknown as Parameters<typeof handleConfigSave>[0];
			const { deps } = createMockHandlerDeps({ orchestrators });

			handleConfigSave(
				mockWs,
				{ type: "config:save", config: { autoMode: "normal" } } as ClientMessage,
				deps,
			);

			expect(skipCalls).toHaveLength(0);
		});
	});

	describe("handleConfigReset", () => {
		test("broadcasts reset config", () => {
			const { ws, deps, broadcastedMessages, configTracker } = setup();

			handleConfigReset(
				ws,
				{
					type: "config:reset",
				} as ClientMessage,
				deps,
			);

			const resetCalls = configTracker.calls.filter((c) => c.method === "reset");
			expect(resetCalls).toHaveLength(1);
			expect(resetCalls[0].args[0]).toBeUndefined();
			expect(broadcastedMessages.some((m) => m.type === "config:state")).toBe(true);
		});

		test("resets a specific key", () => {
			const { ws, deps, broadcastedMessages, configTracker } = setup();

			handleConfigReset(
				ws,
				{
					type: "config:reset",
					key: "models",
				} as ClientMessage,
				deps,
			);

			const resetCalls = configTracker.calls.filter((c) => c.method === "reset");
			expect(resetCalls).toHaveLength(1);
			expect(resetCalls[0].args[0]).toBe("models");
			expect(broadcastedMessages.some((m) => m.type === "config:state")).toBe(true);
		});
	});
});
