// Frontend-agnostic round-trip suite (FR-016, US4 acceptance #1).
//
// For every variant of `ServerMessage` and `ClientMessage`, build a
// known-good fixture, run `parse(serialize(value))`, and assert the
// result deep-equals the original. The fixtures double as the
// canonical-shape inventory used by `exhaustiveness.test.ts`.

import { describe, expect, test } from "bun:test";
import {
	type ClientMessage,
	clientMessageSchema,
	type ServerMessage,
	serverMessageSchema,
} from "../src/index";

// Lock in frontend-agnosticism: this suite must not run with happy-dom
// or any DOM preload (FR-017). `packages/protocol/bunfig.toml` deliberately
// has empty `preload`. The assertion below catches accidental regressions.
test("frontend-agnostic: globalThis.window is undefined", () => {
	expect((globalThis as { window?: unknown }).window).toBeUndefined();
});

const SERVER_FIXTURES: Record<string, ServerMessage> = {
	hello: { type: "hello", protocolVersion: { major: 1, minor: 0 } },
	"workflow:state": { type: "workflow:state", workflow: null },
	"workflow:removed": { type: "workflow:removed", workflowId: "wf_1" },
	"workflow:list": { type: "workflow:list", workflows: [] },
	"workflow:created": {
		type: "workflow:created",
		workflow: { id: "wf_1" } as ServerMessage extends { type: "workflow:created" }
			? never
			: never as never,
	} as ServerMessage,
	"workflow:output": { type: "workflow:output", workflowId: "wf_1", text: "hello" },
	"workflow:tools": { type: "workflow:tools", workflowId: "wf_1", tools: [] },
	"workflow:aspect:output": {
		type: "workflow:aspect:output",
		workflowId: "wf_1",
		aspectId: "asp_1",
		text: "hello",
	},
	"workflow:aspect:tools": {
		type: "workflow:aspect:tools",
		workflowId: "wf_1",
		aspectId: "asp_1",
		tools: [],
	},
	"workflow:aspect:state": {
		type: "workflow:aspect:state",
		workflowId: "wf_1",
		aspectId: "asp_1",
		state: { id: "asp_1" } as never,
	},
	"workflow:question": {
		type: "workflow:question",
		workflowId: "wf_1",
		question: { id: "q_1" } as never,
	},
	"workflow:step-change": {
		type: "workflow:step-change",
		workflowId: "wf_1",
		previousStep: null,
		currentStep: "setup" as never,
		currentStepIndex: 0,
		reviewIteration: 0,
	},
	"epic:list": { type: "epic:list", epics: [] },
	"epic:created": { type: "epic:created", epicId: "e_1", description: "do thing" },
	"epic:output": { type: "epic:output", epicId: "e_1", text: "hi" },
	"epic:tools": { type: "epic:tools", epicId: "e_1", tools: [] },
	"epic:summary": { type: "epic:summary", epicId: "e_1", summary: "ok" },
	"epic:result": {
		type: "epic:result",
		epicId: "e_1",
		title: "Title",
		specCount: 0,
		workflowIds: [],
		summary: null,
	},
	"epic:infeasible": {
		type: "epic:infeasible",
		epicId: "e_1",
		title: "T",
		infeasibleNotes: "...",
	},
	"epic:error": { type: "epic:error", epicId: "e_1", message: "boom" },
	"epic:feedback:accepted": {
		type: "epic:feedback:accepted",
		epicId: "e_1",
		entry: { id: "fb_1" } as never,
	},
	"epic:feedback:rejected": {
		type: "epic:feedback:rejected",
		epicId: "e_1",
		reasonCode: "validation",
		reason: "bad",
	},
	"epic:feedback:history": {
		type: "epic:feedback:history",
		epicId: "e_1",
		entries: [],
		sessionContextLost: false,
	},
	"epic:dependency-update": {
		type: "epic:dependency-update",
		workflowId: "wf_1",
		epicDependencyStatus: "satisfied" as never,
		blockingWorkflows: [],
	},
	"epic:start-first-level:result": {
		type: "epic:start-first-level:result",
		epicId: "e_1",
		started: ["wf_a"],
		skipped: [],
		failed: [],
	},
	"config:state": { type: "config:state", config: { dummy: 1 } as never },
	"telegram:test-result": {
		type: "telegram:test-result",
		ok: true,
		errorCode: null,
		reason: "",
	},
	"telegram:status": {
		type: "telegram:status",
		unacknowledgedCount: 0,
		lastFailureReason: null,
		lastFailureAt: null,
	},
	"default-model:info": { type: "default-model:info", modelInfo: null },
	"config:error": { type: "config:error", errors: [] },
	"purge:progress": { type: "purge:progress", step: "x", current: 0, total: 1 },
	"purge:complete": { type: "purge:complete", warnings: [] },
	"purge:error": { type: "purge:error", message: "boom", warnings: [] },
	"repo:clone-start": {
		type: "repo:clone-start",
		submissionId: "s_1",
		owner: "o",
		repo: "r",
		reused: false,
	},
	"repo:clone-progress": {
		type: "repo:clone-progress",
		submissionId: "s_1",
		owner: "o",
		repo: "r",
		step: "resolving",
	},
	"repo:clone-complete": {
		type: "repo:clone-complete",
		submissionId: "s_1",
		owner: "o",
		repo: "r",
		path: "/tmp/x",
	},
	"repo:clone-error": {
		type: "repo:clone-error",
		submissionId: "s_1",
		owner: "o",
		repo: "r",
		code: "unknown",
		message: "boom",
	},
	"console:output": { type: "console:output", text: "hi" },
	"alert:list": { type: "alert:list", alerts: [] },
	"alert:created": { type: "alert:created", alert: { id: "a_1" } as never },
	"alert:dismissed": { type: "alert:dismissed", alertIds: ["a_1"] },
	"alert:seen": { type: "alert:seen", alertIds: ["a_1"] },
	"workflow:archive-denied": {
		type: "workflow:archive-denied",
		workflowId: "wf_1",
		epicId: null,
		reason: "not-found",
		message: "missing",
	},
	"auto-archive:state": { type: "auto-archive:state", active: true },
	"workflow:feedback:ok": {
		type: "workflow:feedback:ok",
		workflowId: "wf_1",
		kind: "resume-with-feedback",
		feedbackEntryId: "fb_1",
	},
	"workflow:feedback:rejected": {
		type: "workflow:feedback:rejected",
		workflowId: "wf_1",
		reason: "workflow-not-paused",
		currentState: { status: "running" as never, currentStepIndex: 0 },
	},
	error: { type: "error", code: "schema_violation", message: "bad" },
};

const CLIENT_FIXTURES: Record<string, ClientMessage> = {
	"client:hello": { type: "client:hello", protocolVersion: { major: 1, minor: 0 } },
	"workflow:start": { type: "workflow:start", specification: "do thing" },
	"workflow:answer": {
		type: "workflow:answer",
		workflowId: "wf_1",
		questionId: "q_1",
		answer: "yes",
	},
	"workflow:skip": { type: "workflow:skip", workflowId: "wf_1", questionId: "q_1" },
	"workflow:pause": { type: "workflow:pause", workflowId: "wf_1" },
	"workflow:resume": { type: "workflow:resume", workflowId: "wf_1" },
	"workflow:abort": { type: "workflow:abort", workflowId: "wf_1" },
	"workflow:retry": { type: "workflow:retry", workflowId: "wf_1" },
	"workflow:retry-workflow": { type: "workflow:retry-workflow", workflowId: "wf_1" },
	"workflow:finalize": { type: "workflow:finalize", workflowId: "wf_1" },
	"epic:start": { type: "epic:start", description: "x", autoStart: false },
	"epic:abort": { type: "epic:abort" },
	"epic:feedback": { type: "epic:feedback", epicId: "e_1", text: "fb" },
	"epic:feedback:ack-context-lost": {
		type: "epic:feedback:ack-context-lost",
		epicId: "e_1",
	},
	"epic:start-first-level": { type: "epic:start-first-level", epicId: "e_1" },
	"epic:pause-all": { type: "epic:pause-all", epicId: "e_1" },
	"epic:resume-all": { type: "epic:resume-all", epicId: "e_1" },
	"epic:abort-all": { type: "epic:abort-all", epicId: "e_1" },
	"workflow:start-existing": { type: "workflow:start-existing", workflowId: "wf_1" },
	"workflow:force-start": { type: "workflow:force-start", workflowId: "wf_1" },
	"workflow:feedback": { type: "workflow:feedback", workflowId: "wf_1", text: "fb" },
	"config:get": { type: "config:get" },
	"config:save": { type: "config:save", config: {} },
	"config:reset": { type: "config:reset" },
	"telegram:test": { type: "telegram:test", botToken: "x", chatId: "y" },
	"telegram:acknowledge": { type: "telegram:acknowledge" },
	"alert:list": { type: "alert:list" },
	"alert:dismiss": { type: "alert:dismiss", alertId: "a_1" },
	"alert:clear-all": { type: "alert:clear-all" },
	"alert:route-changed": { type: "alert:route-changed", path: "/" },
	"workflow:archive": { type: "workflow:archive", workflowId: "wf_1" },
	"workflow:unarchive": { type: "workflow:unarchive", workflowId: "wf_1" },
	"epic:archive": { type: "epic:archive", epicId: "e_1" },
	"epic:unarchive": { type: "epic:unarchive", epicId: "e_1" },
	"auto-archive:stop": { type: "auto-archive:stop" },
	"auto-archive:start": { type: "auto-archive:start" },
	"purge:all": { type: "purge:all" },
	"client:warning": { type: "client:warning", source: "x", message: "y" },
};

export const FIXTURE_TYPES = {
	server: SERVER_FIXTURES,
	client: CLIENT_FIXTURES,
};

describe("ServerMessage round-trip", () => {
	for (const [variant, fixture] of Object.entries(SERVER_FIXTURES)) {
		test(variant, () => {
			const serialized = JSON.stringify(fixture);
			const parsed = serverMessageSchema.parse(JSON.parse(serialized));
			expect(parsed).toEqual(fixture);
		});
	}
});

describe("ClientMessage round-trip", () => {
	for (const [variant, fixture] of Object.entries(CLIENT_FIXTURES)) {
		test(variant, () => {
			const serialized = JSON.stringify(fixture);
			const parsed = clientMessageSchema.parse(JSON.parse(serialized));
			expect(parsed).toEqual(fixture);
		});
	}
});

describe("real Bun.serve WebSocket round-trip", () => {
	test("ClientMessage variants accepted by safeParse on a live socket", async () => {
		// Spin up a tiny Bun.serve instance whose websocket handler runs
		// every inbound frame through `clientMessageSchema.safeParse`.
		const server = Bun.serve({
			port: 0,
			fetch(req, srv) {
				if (srv.upgrade(req)) return;
				return new Response("no upgrade");
			},
			websocket: {
				message(ws, raw) {
					const result = clientMessageSchema.safeParse(JSON.parse(String(raw)));
					ws.send(JSON.stringify({ ok: result.success }));
				},
			},
		});
		try {
			const url = `ws://localhost:${server.port}/`;
			for (const fixture of Object.values(CLIENT_FIXTURES)) {
				const ws = new WebSocket(url);
				const reply = await new Promise<{ ok: boolean }>((resolve, reject) => {
					ws.onmessage = (ev) => {
						try {
							resolve(JSON.parse(String(ev.data)));
						} catch (err) {
							reject(err);
						}
					};
					ws.onopen = () => ws.send(JSON.stringify(fixture));
					ws.onerror = (err) => reject(err);
				});
				ws.close();
				expect(reply.ok).toBe(true);
			}
		} finally {
			server.stop(true);
		}
	});

	test("ServerMessage variants accepted by safeParse on a live socket", async () => {
		// Synthetic server emits each fixture; client safeParse-checks.
		const fixtures = Object.values(SERVER_FIXTURES);
		const server = Bun.serve({
			port: 0,
			fetch(req, srv) {
				if (srv.upgrade(req)) return;
				return new Response("no upgrade");
			},
			websocket: {
				open(ws) {
					for (const f of fixtures) ws.send(JSON.stringify(f));
				},
				message() {
					/* unused */
				},
			},
		});
		try {
			const url = `ws://localhost:${server.port}/`;
			const ws = new WebSocket(url);
			let ok = true;
			let received = 0;
			await new Promise<void>((resolve, reject) => {
				ws.onmessage = (ev) => {
					const result = serverMessageSchema.safeParse(JSON.parse(String(ev.data)));
					if (!result.success) {
						ok = false;
					}
					received += 1;
					if (received === fixtures.length) resolve();
				};
				ws.onerror = (err) => reject(err);
				setTimeout(() => reject(new Error("timeout")), 5000);
			});
			ws.close();
			expect(ok).toBe(true);
			expect(received).toBe(fixtures.length);
		} finally {
			server.stop(true);
		}
	});
});
