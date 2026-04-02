import { describe, test, expect, beforeEach, mock } from "bun:test";
import { Summarizer } from "../src/summarizer";

// Mock the Anthropic SDK
const mockCreate = mock(() =>
  Promise.resolve({
    content: [{ type: "text" as const, text: "Setting up project" }],
  })
);

mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

// Flush microtask queue to let fire-and-forget promises resolve
async function flushAsync() {
  // Two ticks: one for the API call promise, one for the .then() callback
  await Promise.resolve();
  await Promise.resolve();
}

describe("Summarizer", () => {
  let summarizer: Summarizer;

  beforeEach(() => {
    summarizer = new Summarizer();
    mockCreate.mockClear();
  });

  test("does not trigger summary below MIN_CHARS threshold", () => {
    const callback = mock(() => {});
    summarizer.maybeSummarize("w1", "short text", callback);
    expect(callback).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("triggers summary when enough text accumulated", async () => {
    const callback = mock(() => {});
    const longText = "x".repeat(250);
    summarizer.maybeSummarize("w1", longText, callback);

    await flushAsync();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0] as any;
    expect(callArgs.model).toBe("claude-haiku-4-5-20251001");
    expect(callArgs.max_tokens).toBe(50);
    expect(callback).toHaveBeenCalledWith("Setting up project");
  });

  test("does not double-trigger while summary is pending", async () => {
    const callback = mock(() => {});
    const longText = "x".repeat(250);

    summarizer.maybeSummarize("w1", longText, callback);
    // Second call immediately — pendingSummary should block it
    summarizer.maybeSummarize("w1", longText, callback);

    await flushAsync();

    // Only one API call despite two maybeSummarize calls
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("throttles by INTERVAL_MS after a completed summary", async () => {
    const callback = mock(() => {});
    const longText = "x".repeat(250);

    summarizer.maybeSummarize("w1", longText, callback);
    await flushAsync();

    // First summary completed, but within INTERVAL_MS
    mockCreate.mockClear();
    summarizer.maybeSummarize("w1", longText, callback);

    await flushAsync();
    // Should not trigger again within interval
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("accumulates text per workflow ID independently", async () => {
    const cb1 = mock(() => {});
    const cb2 = mock(() => {});
    const longText = "x".repeat(250);

    summarizer.maybeSummarize("w1", longText, cb1);
    summarizer.maybeSummarize("w2", longText, cb2);

    await flushAsync();

    // Both workflows should trigger independently
    expect(mockCreate).toHaveBeenCalledTimes(2);
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

  test("handles API error gracefully without calling callback", async () => {
    mockCreate.mockImplementationOnce(() => Promise.reject(new Error("API down")));

    const callback = mock(() => {});
    const longText = "x".repeat(250);
    summarizer.maybeSummarize("w1", longText, callback);

    await flushAsync();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
  });
});
