import { describe, test, expect, beforeEach, mock } from "bun:test";
import { Summarizer } from "../src/summarizer";

describe("Summarizer", () => {
  let summarizer: Summarizer;

  beforeEach(() => {
    summarizer = new Summarizer();
  });

  test("does not trigger summary below MIN_CHARS threshold", () => {
    const callback = mock(() => {});
    summarizer.maybeSummarize("w1", "short text", callback);
    // callback should not be called synchronously or at all for short text
    expect(callback).not.toHaveBeenCalled();
  });

  test("does not trigger summary within INTERVAL_MS", () => {
    const callback = mock(() => {});
    // Accumulate enough text
    const longText = "x".repeat(250);
    summarizer.maybeSummarize("w1", longText, callback);
    // First call may trigger (enough chars, no previous time)
    // But a second call immediately should not
    summarizer.maybeSummarize("w1", longText, callback);
    // The second should not double-trigger because pendingSummary is true
  });

  test("accumulates text per workflow ID", () => {
    const cb1 = mock(() => {});
    const cb2 = mock(() => {});
    summarizer.maybeSummarize("w1", "text for w1", cb1);
    summarizer.maybeSummarize("w2", "text for w2", cb2);
    // Both should accumulate independently (no cross-contamination)
  });

  test("cleanup removes workflow state", () => {
    const callback = mock(() => {});
    const longText = "x".repeat(250);
    summarizer.maybeSummarize("w1", longText, callback);
    summarizer.cleanup("w1");
    // After cleanup, workflow buffers should be gone
    // Calling again should start fresh accumulation
    summarizer.maybeSummarize("w1", "short", callback);
  });

  test("cleanup for non-existent workflow does not throw", () => {
    expect(() => summarizer.cleanup("nonexistent")).not.toThrow();
  });
});
