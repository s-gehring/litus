import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Summarizer } from "../src/summarizer";

const originalSpawn = Bun.spawn;

function mockSpawnResponse(text: string, exitCode = 0) {
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
	return {
		stdout: stream,
		stderr: new ReadableStream({
			start(c) {
				c.close();
			},
		}),
		exited: Promise.resolve(exitCode),
		pid: 1,
		kill: () => {},
	};
}

// Flush microtask queue to let fire-and-forget promises resolve
async function flushAsync() {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

describe("Summarizer", () => {
	let summarizer: Summarizer;
	let spawnMock: ReturnType<typeof mock>;

	beforeEach(() => {
		summarizer = new Summarizer();
		spawnMock = mock(() => mockSpawnResponse("Setting up project"));
		Bun.spawn = spawnMock as typeof Bun.spawn;
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
	});

	test("does not trigger summary below MIN_CHARS threshold", () => {
		const callback = mock(() => {});
		summarizer.maybeSummarize("w1", "short text", callback);
		expect(callback).not.toHaveBeenCalled();
		expect(spawnMock).not.toHaveBeenCalled();
	});

	test("triggers summary when enough text accumulated", async () => {
		const callback = mock(() => {});
		const longText = "x".repeat(250);
		summarizer.maybeSummarize("w1", longText, callback);

		await flushAsync();

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const args = (spawnMock.mock.calls as unknown[][])[0][0] as string[];
		expect(args).toContain("--model");
		expect(args).toContain("claude-haiku-4-5-20251001");
		expect(callback).toHaveBeenCalledWith("Setting up project");
	});

	test("does not double-trigger while summary is pending", async () => {
		const callback = mock(() => {});
		const longText = "x".repeat(250);

		summarizer.maybeSummarize("w1", longText, callback);
		// Second call immediately — pendingSummary should block it
		summarizer.maybeSummarize("w1", longText, callback);

		await flushAsync();

		// Only one spawn call despite two maybeSummarize calls
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	test("throttles by INTERVAL_MS after a completed summary", async () => {
		const callback = mock(() => {});
		const longText = "x".repeat(250);

		summarizer.maybeSummarize("w1", longText, callback);
		await flushAsync();

		// First summary completed, but within INTERVAL_MS
		spawnMock.mockClear();
		summarizer.maybeSummarize("w1", longText, callback);

		await flushAsync();
		// Should not trigger again within interval
		expect(spawnMock).not.toHaveBeenCalled();
	});

	test("accumulates text per workflow ID independently", async () => {
		const cb1 = mock(() => {});
		const cb2 = mock(() => {});
		const longText = "x".repeat(250);

		summarizer.maybeSummarize("w1", longText, cb1);
		summarizer.maybeSummarize("w2", longText, cb2);

		await flushAsync();

		// Both workflows should trigger independently
		expect(spawnMock).toHaveBeenCalledTimes(2);
	});

	test("cleanup removes workflow state", () => {
		const callback = mock(() => {});
		const longText = "x".repeat(250);
		summarizer.maybeSummarize("w1", longText, callback);
		summarizer.cleanup("w1");
		// After cleanup, workflow buffers should be gone
		summarizer.maybeSummarize("w1", "short", callback);
		// Short text after cleanup should not trigger (fresh accumulation)
	});

	test("cleanup for non-existent workflow does not throw", () => {
		expect(() => summarizer.cleanup("nonexistent")).not.toThrow();
	});

	test("handles CLI error gracefully without calling callback", async () => {
		spawnMock = mock(() => mockSpawnResponse("", 1));
		Bun.spawn = spawnMock as typeof Bun.spawn;

		const callback = mock(() => {});
		const longText = "x".repeat(250);
		summarizer.maybeSummarize("w1", longText, callback);

		await flushAsync();

		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(callback).not.toHaveBeenCalled();
	});
});
