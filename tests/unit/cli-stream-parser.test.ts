import { describe, expect, test } from "bun:test";
import { parseClaudeStream } from "../../src/cli-stream-parser";
import { createReadableStream } from "../test-infra/streams";

const ndjson = (events: unknown[]): string[] => events.map((e) => `${JSON.stringify(e)}\n`);

describe("parseClaudeStream", () => {
	describe("B-1 line splitting + final-buffer attempt", () => {
		test("splits on \\n, skips whitespace-only lines, processes a non-empty trailing buffer", async () => {
			const outputs: string[] = [];
			// Last chunk has no trailing newline → final-buffer path must still parse it.
			const stream = createReadableStream([
				`${JSON.stringify({ type: "content_block_delta", delta: { text: "a" } })}\n`,
				"   \n",
				"\n",
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: "final" }] },
				}),
			]);

			const result = await parseClaudeStream(stream, {
				onText: (t) => {
					outputs.push(t);
				},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(outputs.join("")).toBe("final");
			expect(result.accumulatedText).toBe("final");
		});

		test("a non-JSON trailing buffer is routed through onJsonLine fallback", async () => {
			const jsonLines: string[] = [];
			const stream = createReadableStream(["not-valid-json"]);

			await parseClaudeStream(stream, {
				onText: () => {},
				onTools: () => {},
				onSessionId: () => {},
				onJsonLine: (line) => {
					jsonLines.push(line);
				},
			});

			expect(jsonLines).toEqual(["not-valid-json"]);
		});
	});

	describe("B-2 delta buffering + flush + post-resolve guarantee", () => {
		test("flushes pending deltas at stream end and stops invoking callbacks afterwards", async () => {
			const outputs: string[] = [];
			const stream = createReadableStream(
				ndjson([
					{ type: "content_block_delta", delta: { text: "Hello " } },
					{ type: "content_block_delta", delta: { text: "world" } },
				]),
			);

			await parseClaudeStream(stream, {
				onText: (t) => {
					outputs.push(t);
				},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(outputs.join("")).toBe("Hello world");

			// After the returned promise resolves, the callback bag should not
			// fire again — wait a tick longer than DELTA_FLUSH_TIMEOUT_MS (50ms)
			// to let any latent timer run.
			await new Promise((r) => setTimeout(r, 80));
			expect(outputs.join("")).toBe("Hello world");
		});
	});

	describe("B-3 assistant precedence + turn reset", () => {
		test("discards unflushed deltas and emits assistant text exactly once", async () => {
			const outputs: string[] = [];
			const stream = createReadableStream(
				ndjson([
					{ type: "content_block_delta", delta: { text: "Hello " } },
					{ type: "content_block_delta", delta: { text: "world" } },
					{
						type: "assistant",
						message: { content: [{ type: "text", text: "Hello world" }] },
					},
				]),
			);

			await parseClaudeStream(stream, {
				onText: (t) => {
					outputs.push(t);
				},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(outputs.join("")).toBe("Hello world");
		});

		test("emits only the unsent tail when an assistant event grows incrementally (FR-005)", async () => {
			// Distinguishes the spec'd "track to currentText.length" rule from the
			// older "reset to 0 after every assistant event" semantics. Under the
			// rejected rule this would emit "HelloHello world".
			const outputs: string[] = [];
			const stream = createReadableStream(
				ndjson([
					{
						type: "assistant",
						message: { content: [{ type: "text", text: "Hello" }] },
					},
					{
						type: "assistant",
						message: { content: [{ type: "text", text: "Hello world" }] },
					},
				]),
			);

			await parseClaudeStream(stream, {
				onText: (t) => {
					outputs.push(t);
				},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(outputs.join("")).toBe("Hello world");
		});

		test("FR-006 conditional reset triggers when cumulative text shrinks after a delta-flushed prefix", async () => {
			// Drives `assistantSentLen` non-zero via a flushed delta first (the
			// only path under which FR-006's `currentText.length < assistantSentLen`
			// branch is reachable today), then sends a shorter assistant event so
			// the reset must fire to avoid `slice(assistantSentLen)` returning "".
			const outputs: string[] = [];
			// Use a manual stream so we can interleave a wait long enough for the
			// 50ms delta-flush timer to fire before the assistant event arrives.
			const encoder = new TextEncoder();
			const interleaved = new ReadableStream<Uint8Array>({
				async pull(controller) {
					controller.enqueue(
						encoder.encode(
							`${JSON.stringify({
								type: "content_block_delta",
								delta: { text: "long-prior-flushed-prefix" },
							})}\n`,
						),
					);
					await new Promise((r) => setTimeout(r, 80));
					controller.enqueue(
						encoder.encode(
							`${JSON.stringify({
								type: "assistant",
								message: { content: [{ type: "text", text: "tiny" }] },
							})}\n`,
						),
					);
					controller.close();
				},
			});
			await parseClaudeStream(interleaved, {
				onText: (t) => {
					outputs.push(t);
				},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(outputs.join("")).toBe("long-prior-flushed-prefixtiny");
		});

		test("flushed delta deduplicates against a subsequent matching-prefix assistant event (FR-005)", async () => {
			// Flush a delta, then deliver an assistant event whose cumulative text
			// starts with the flushed prefix — only the unsent tail should emit.
			const outputs: string[] = [];
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					controller.enqueue(
						encoder.encode(
							`${JSON.stringify({
								type: "content_block_delta",
								delta: { text: "Hello " },
							})}\n`,
						),
					);
					await new Promise((r) => setTimeout(r, 80));
					controller.enqueue(
						encoder.encode(
							`${JSON.stringify({
								type: "assistant",
								message: { content: [{ type: "text", text: "Hello world" }] },
							})}\n`,
						),
					);
					controller.close();
				},
			});

			await parseClaudeStream(stream, {
				onText: (t) => {
					outputs.push(t);
				},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(outputs.join("")).toBe("Hello world");
		});
	});

	describe("B-4 tool-block extraction", () => {
		test("collects tool_use blocks (with and without input) from an assistant event", async () => {
			const toolCalls: Array<Array<{ name: string; input?: unknown }>> = [];
			const stream = createReadableStream(
				ndjson([
					{
						type: "assistant",
						message: {
							content: [
								{ type: "tool_use", name: "Bash", input: { command: "ls" } },
								{ type: "tool_use", name: "Write" },
							],
						},
					},
				]),
			);

			await parseClaudeStream(stream, {
				onText: () => {},
				onTools: (tools) => {
					toolCalls.push(tools);
				},
				onSessionId: () => {},
			});

			expect(toolCalls).toHaveLength(1);
			expect(toolCalls[0]).toEqual([
				{ name: "Bash", input: { command: "ls" } },
				{ name: "Write", input: undefined },
			]);
		});
	});

	describe("B-5 session_id single-fire", () => {
		test("captures the first non-empty session_id and ignores subsequent values", async () => {
			const observed: string[] = [];
			const stream = createReadableStream(
				ndjson([
					{ type: "system", session_id: "" },
					{ type: "system", session_id: "first-id" },
					{ type: "system", session_id: "second-id" },
				]),
			);

			const result = await parseClaudeStream(stream, {
				onText: () => {},
				onTools: () => {},
				onSessionId: (id) => {
					observed.push(id);
				},
			});

			expect(observed).toEqual(["first-id"]);
			expect(result.sessionId).toBe("first-id");
		});

		test("returns null sessionId when no event carries one", async () => {
			const stream = createReadableStream(
				ndjson([{ type: "content_block_delta", delta: { text: "x" } }]),
			);

			const result = await parseClaudeStream(stream, {
				onText: () => {},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(result.sessionId).toBeNull();
		});
	});

	describe("B-6 result event handling", () => {
		test("flushes pending deltas and forwards a non-empty trimmed result string", async () => {
			const outputs: string[] = [];
			const stream = createReadableStream(
				ndjson([
					{ type: "content_block_delta", delta: { text: "abc" } },
					{ type: "result", result: "  done  " },
				]),
			);

			await parseClaudeStream(stream, {
				onText: (t) => {
					outputs.push(t);
				},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(outputs).toEqual(["abc", "done"]);
		});

		test("flushes pending delta but emits no extra onText when result is non-string (B-6)", async () => {
			// Asserts both halves of B-6: the internal delta flush still fires
			// (so the buffered "abc" reaches onText), but the non-string `result`
			// itself produces no additional onText invocation.
			const outputs: string[] = [];
			const stream = createReadableStream(
				ndjson([
					{ type: "content_block_delta", delta: { text: "abc" } },
					{ type: "result", result: 42 },
				]),
			);

			await parseClaudeStream(stream, {
				onText: (t) => {
					outputs.push(t);
				},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(outputs).toEqual(["abc"]);
		});
	});

	describe("B-7 JSON parse failure routing", () => {
		test("routes a malformed line via onJsonLine when provided", async () => {
			const onJsonLineCalls: string[] = [];
			const onTextCalls: string[] = [];
			const stream = createReadableStream([
				"not-valid-json\n",
				`${JSON.stringify({ type: "content_block_delta", delta: { text: "x" } })}\n`,
			]);

			await parseClaudeStream(stream, {
				onText: (t) => {
					onTextCalls.push(t);
				},
				onTools: () => {},
				onSessionId: () => {},
				onJsonLine: (line) => {
					onJsonLineCalls.push(line);
				},
			});

			expect(onJsonLineCalls).toEqual(["not-valid-json"]);
			expect(onTextCalls).toEqual(["x"]);
		});

		test("falls back to onText when onJsonLine is not provided", async () => {
			const outputs: string[] = [];
			const stream = createReadableStream(["not-valid-json\n"]);

			await parseClaudeStream(stream, {
				onText: (t) => {
					outputs.push(t);
				},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(outputs).toEqual(["not-valid-json"]);
		});
	});

	describe("B-8 return value", () => {
		test("accumulatedText falls back to delta-accumulated when no assistant event arrives", async () => {
			const stream = createReadableStream(
				ndjson([
					{ type: "content_block_delta", delta: { text: "alpha " } },
					{ type: "content_block_delta", delta: { text: "beta" } },
				]),
			);

			const result = await parseClaudeStream(stream, {
				onText: () => {},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(result.accumulatedText).toBe("alpha beta");
		});

		test("accumulatedText prefers lastAssistantText when an assistant event arrived", async () => {
			const stream = createReadableStream(
				ndjson([
					{ type: "content_block_delta", delta: { text: "frag" } },
					{
						type: "assistant",
						message: { content: [{ type: "text", text: "authoritative" }] },
					},
				]),
			);

			const result = await parseClaudeStream(stream, {
				onText: () => {},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(result.accumulatedText).toBe("authoritative");
		});
	});

	describe("B-9 read-error tolerance", () => {
		test("resolves normally when reader.read() throws mid-stream", async () => {
			let pulls = 0;
			const errored = new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls += 1;
					if (pulls === 1) {
						controller.enqueue(
							new TextEncoder().encode(
								`${JSON.stringify({ type: "content_block_delta", delta: { text: "partial" } })}\n`,
							),
						);
						return;
					}
					controller.error(new Error("simulated read error"));
				},
			});

			const result = await parseClaudeStream(errored, {
				onText: () => {},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(result.accumulatedText).toBe("partial");
		});
	});

	describe("B-10 callback exception tolerance", () => {
		test("synchronous throws and rejected promises in callbacks are swallowed; parser keeps draining", async () => {
			const assistantMessages: string[] = [];
			const stream = createReadableStream(
				ndjson([
					{ type: "content_block_delta", delta: { text: "x" } },
					{
						type: "assistant",
						message: { content: [{ type: "text", text: "hello" }] },
					},
				]),
			);

			const result = await parseClaudeStream(stream, {
				onText: () => {
					throw new Error("sync throw");
				},
				onTools: () => Promise.reject(new Error("rejected")),
				onSessionId: () => {},
				onAssistantMessage: (text) => {
					assistantMessages.push(text);
				},
			});

			// Despite onText throwing on every invocation, parsing reaches the
			// assistant event and onAssistantMessage still fires.
			expect(assistantMessages).toEqual(["hello"]);
			expect(result.accumulatedText).toBe("hello");
		});
	});

	describe("B-11 backpressure + ordering", () => {
		test("invokes onEvent → onText → onTools → onAssistantMessage in order for one assistant event", async () => {
			const order: string[] = [];
			const stream = createReadableStream(
				ndjson([
					{
						type: "assistant",
						message: {
							content: [
								{ type: "text", text: "T" },
								{ type: "tool_use", name: "Bash", input: {} },
							],
						},
					},
				]),
			);

			await parseClaudeStream(stream, {
				onEvent: () => {
					order.push("onEvent");
				},
				onText: () => {
					order.push("onText");
				},
				onTools: () => {
					order.push("onTools");
				},
				onSessionId: () => {},
				onAssistantMessage: () => {
					order.push("onAssistantMessage");
				},
			});

			expect(order).toEqual(["onEvent", "onText", "onTools", "onAssistantMessage"]);
		});

		test("awaits each callback before processing the next event", async () => {
			const order: string[] = [];
			const stream = createReadableStream(
				ndjson([
					{ type: "content_block_delta", delta: { text: "1" } },
					{ type: "content_block_delta", delta: { text: "2" } },
					{
						type: "assistant",
						message: { content: [{ type: "text", text: "12" }] },
					},
				]),
			);

			await parseClaudeStream(stream, {
				onEvent: async (event) => {
					await new Promise((r) => setTimeout(r, 10));
					order.push(`event:${event.type}`);
				},
				onText: () => {},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(order).toEqual([
				"event:content_block_delta",
				"event:content_block_delta",
				"event:assistant",
			]);
		});
	});

	describe("malformed-shape tolerance (silent-drop contract)", () => {
		test("tool_use blocks with missing or empty name are silently dropped", async () => {
			const toolCalls: Array<Array<{ name: string; input?: unknown }>> = [];
			const stream = createReadableStream(
				ndjson([
					{
						type: "assistant",
						message: {
							content: [
								{ type: "tool_use", input: { command: "ls" } },
								{ type: "tool_use", name: "", input: {} },
								{ type: "tool_use", name: "Read", input: { path: "x" } },
							],
						},
					},
				]),
			);

			await parseClaudeStream(stream, {
				onText: () => {},
				onTools: (tools) => {
					toolCalls.push(tools);
				},
				onSessionId: () => {},
			});

			expect(toolCalls).toEqual([[{ name: "Read", input: { path: "x" } }]]);
		});

		test("assistant events whose message.content is not an array are silently ignored", async () => {
			const outputs: string[] = [];
			const assistantMessages: string[] = [];
			const stream = createReadableStream(
				ndjson([
					{ type: "assistant", message: { content: "string-not-array" } },
					{ type: "assistant", message: {} },
					{
						type: "assistant",
						message: { content: [{ type: "text", text: "after" }] },
					},
				]),
			);

			await parseClaudeStream(stream, {
				onText: (t) => {
					outputs.push(t);
				},
				onTools: () => {},
				onSessionId: () => {},
				onAssistantMessage: (t) => {
					assistantMessages.push(t);
				},
			});

			expect(outputs).toEqual(["after"]);
			expect(assistantMessages).toEqual(["after"]);
		});

		test("non-string session_id values are silently ignored", async () => {
			const observed: string[] = [];
			const stream = createReadableStream(
				ndjson([
					{ type: "system", session_id: null },
					{ type: "system", session_id: 42 },
					{ type: "system", session_id: "real-id" },
				]),
			);

			const result = await parseClaudeStream(stream, {
				onText: () => {},
				onTools: () => {},
				onSessionId: (id) => {
					observed.push(id);
				},
			});

			expect(observed).toEqual(["real-id"]);
			expect(result.sessionId).toBe("real-id");
		});
	});

	describe("prefix-assumption violation path", () => {
		test("flushed delta followed by an assistant event whose text does not start with the prefix", async () => {
			// Documents B-3 step 3's shrink-reset behavior when the assistant
			// text length is shorter than the flushed-delta watermark and does
			// not start with the prefix. Under FR-006 the watermark resets to
			// 0 and the full assistant text emits — yielding a duplicated
			// prefix on screen, which is the documented recovery for this
			// violation of B-2's prefix assumption (slow-onEvent race included).
			const outputs: string[] = [];
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					controller.enqueue(
						encoder.encode(
							`${JSON.stringify({
								type: "content_block_delta",
								delta: { text: "abc1" },
							})}\n`,
						),
					);
					await new Promise((r) => setTimeout(r, 80));
					controller.enqueue(
						encoder.encode(
							`${JSON.stringify({
								type: "assistant",
								message: { content: [{ type: "text", text: "Hi" }] },
							})}\n`,
						),
					);
					controller.close();
				},
			});

			await parseClaudeStream(stream, {
				onText: (t) => {
					outputs.push(t);
				},
				onTools: () => {},
				onSessionId: () => {},
			});

			expect(outputs).toEqual(["abc1", "Hi"]);
		});
	});
});
