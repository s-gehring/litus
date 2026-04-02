import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { CLIRunner } from "../src/cli-runner";
import type { CLICallbacks } from "../src/cli-runner";

const originalSpawn = Bun.spawn;

describe("CLIRunner", () => {
  let runner: CLIRunner;

  beforeEach(() => {
    runner = new CLIRunner();
  });

  afterAll(() => {
    (globalThis as any).Bun.spawn = originalSpawn;
  });

  describe("handleStreamEvent (via streamOutput)", () => {
    test("extracts session_id from stream events", async () => {
      let capturedSessionId: string | null = null;

      const streamContent = [
        JSON.stringify({ session_id: "sess-abc-123", type: "system", message: {} }),
        JSON.stringify({ type: "content_block_delta", delta: { text: "Hello" } }),
        "",
      ].join("\n");

      (globalThis as any).Bun.spawn = () => ({
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(streamContent));
            controller.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: () => {},
        pid: 1,
      });

      const callbacks: CLICallbacks = {
        onOutput: () => {},
        onComplete: () => {},
        onError: () => {},
        onSessionId: (id) => { capturedSessionId = id; },
      };

      runner.start(
        {
          id: "w1",
          specification: "test",
          status: "running",
          sessionId: null,
          worktreePath: "/tmp/test",
          worktreeBranch: "test-branch",
          summary: "",
          pendingQuestion: null,
          lastOutput: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        callbacks
      );

      // Wait for stream processing
      await new Promise((r) => setTimeout(r, 100));
      expect(capturedSessionId).toBe("sess-abc-123");
    });

    test("emits text content from assistant messages", async () => {
      const outputs: string[] = [];

      const streamContent = [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "I'll create the file now" },
              { type: "tool_use", name: "write_file" },
            ],
          },
        }),
        "",
      ].join("\n");

      (globalThis as any).Bun.spawn = () => ({
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(streamContent));
            controller.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: () => {},
        pid: 1,
      });

      const callbacks: CLICallbacks = {
        onOutput: (text) => outputs.push(text),
        onComplete: () => {},
        onError: () => {},
      };

      runner.start(
        {
          id: "w2",
          specification: "test",
          status: "running",
          sessionId: null,
          worktreePath: null,
          worktreeBranch: "test",
          summary: "",
          pendingQuestion: null,
          lastOutput: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        callbacks
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(outputs).toContain("I'll create the file now");
      expect(outputs).toContain("[Tool: write_file]");
    });

    test("calls onComplete on successful exit", async () => {
      let completed = false;

      (globalThis as any).Bun.spawn = () => ({
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: () => {},
        pid: 1,
      });

      runner.start(
        {
          id: "w3",
          specification: "test",
          status: "running",
          sessionId: null,
          worktreePath: null,
          worktreeBranch: "test",
          summary: "",
          pendingQuestion: null,
          lastOutput: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          onOutput: () => {},
          onComplete: () => { completed = true; },
          onError: () => {},
        }
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(completed).toBe(true);
    });

    test("calls onError on non-zero exit", async () => {
      let errorMsg = "";

      (globalThis as any).Bun.spawn = () => ({
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("process crashed"));
            controller.close();
          },
        }),
        exited: Promise.resolve(1),
        kill: () => {},
        pid: 1,
      });

      runner.start(
        {
          id: "w4",
          specification: "test",
          status: "running",
          sessionId: null,
          worktreePath: null,
          worktreeBranch: "test",
          summary: "",
          pendingQuestion: null,
          lastOutput: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          onOutput: () => {},
          onComplete: () => {},
          onError: (err) => { errorMsg = err; },
        }
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(errorMsg).toContain("process crashed");
    });
  });

  describe("kill", () => {
    test("kills a running process", () => {
      let killed = false;
      (globalThis as any).Bun.spawn = () => ({
        stdout: new ReadableStream({ start() {} }), // never closes
        stderr: new ReadableStream({ start() {} }),
        exited: new Promise(() => {}), // never resolves
        kill: () => { killed = true; },
        pid: 1,
      });

      runner.start(
        {
          id: "w5",
          specification: "test",
          status: "running",
          sessionId: null,
          worktreePath: null,
          worktreeBranch: "test",
          summary: "",
          pendingQuestion: null,
          lastOutput: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { onOutput: () => {}, onComplete: () => {}, onError: () => {} }
      );

      runner.kill("w5");
      expect(killed).toBe(true);
    });

    test("kill on non-existent workflow does not throw", () => {
      expect(() => runner.kill("nonexistent")).not.toThrow();
    });
  });

  describe("killAll", () => {
    test("kills all running processes", () => {
      const killed: string[] = [];
      (globalThis as any).Bun.spawn = () => ({
        stdout: new ReadableStream({ start() {} }),
        stderr: new ReadableStream({ start() {} }),
        exited: new Promise(() => {}),
        kill: () => { killed.push("killed"); },
        pid: 1,
      });

      const makeWorkflow = (id: string) => ({
        id,
        specification: "test",
        status: "running" as const,
        sessionId: null,
        worktreePath: null,
        worktreeBranch: "test",
        summary: "",
        pendingQuestion: null,
        lastOutput: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const cb = { onOutput: () => {}, onComplete: () => {}, onError: () => {} };
      runner.start(makeWorkflow("a"), cb);
      runner.start(makeWorkflow("b"), cb);

      runner.killAll();
      expect(killed.length).toBe(2);
    });
  });
});
