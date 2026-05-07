// Frontend-agnostic round-trip suite (FR-016, US4 acceptance #1).
//
// For every variant of `ServerMessage` and `ClientMessage`, build a
// known-good fixture, run `parse(serialize(value))`, and assert the
// result deep-equals the original. Fixtures live in `./fixtures.ts`.

import { describe, expect, test } from "bun:test";
import "./frontend-agnostic-guard";
import { clientMessageSchema, serverMessageSchema } from "../src/index";
import { CLIENT_FIXTURES, SERVER_FIXTURES } from "./fixtures";

test("frontend-agnostic: globalThis.window is undefined", () => {
	expect((globalThis as { window?: unknown }).window).toBeUndefined();
});

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

			// Negative case: a malformed frame must fail safeParse. Without
			// this, a regression that turns `safeParse` into a constant
			// `{ success: true }` would not fail the suite (review #10).
			const badFrames: unknown[] = [
				{ type: "definitely-not-a-real-variant" },
				{ type: "workflow:answer", workflowId: "wf_1" }, // missing questionId/answer
				{ notEvenAType: true },
			];
			for (const bad of badFrames) {
				const ws = new WebSocket(url);
				const reply = await new Promise<{ ok: boolean }>((resolve, reject) => {
					ws.onmessage = (ev) => {
						try {
							resolve(JSON.parse(String(ev.data)));
						} catch (err) {
							reject(err);
						}
					};
					ws.onopen = () => ws.send(JSON.stringify(bad));
					ws.onerror = (err) => reject(err);
				});
				ws.close();
				expect(reply.ok).toBe(false);
			}
		} finally {
			server.stop(true);
		}
	});

	test("ServerMessage variants accepted by safeParse on a live socket", async () => {
		// Synthetic server emits each fixture; client safeParse-checks.
		// Includes a malformed trailer frame to assert the negative path.
		const fixtures = Object.values(SERVER_FIXTURES);
		const malformed = { type: "definitely-not-a-real-variant" };
		const server = Bun.serve({
			port: 0,
			fetch(req, srv) {
				if (srv.upgrade(req)) return;
				return new Response("no upgrade");
			},
			websocket: {
				open(ws) {
					for (const f of fixtures) ws.send(JSON.stringify(f));
					ws.send(JSON.stringify(malformed));
				},
				message() {
					/* unused */
				},
			},
		});
		try {
			const url = `ws://localhost:${server.port}/`;
			const ws = new WebSocket(url);
			const results: boolean[] = [];
			await new Promise<void>((resolve, reject) => {
				ws.onmessage = (ev) => {
					const result = serverMessageSchema.safeParse(JSON.parse(String(ev.data)));
					results.push(result.success);
					if (results.length === fixtures.length + 1) resolve();
				};
				ws.onerror = (err) => reject(err);
				setTimeout(() => reject(new Error("timeout")), 5000);
			});
			ws.close();
			// All canonical fixtures parse; the trailer must reject.
			expect(results.slice(0, fixtures.length).every((r) => r === true)).toBe(true);
			expect(results[fixtures.length]).toBe(false);
		} finally {
			server.stop(true);
		}
	});
});
