import type { Workflow } from "./types";

export interface CLICallbacks {
  onOutput: (text: string) => void;
  onComplete: () => void;
  onError: (error: string) => void;
  onSessionId?: (sessionId: string) => void;
}

interface RunningProcess {
  process: ReturnType<typeof Bun.spawn>;
  workflowId: string;
  sessionId: string | null;
  cwd: string;
  callbacks: CLICallbacks;
}

export class CLIRunner {
  private running: Map<string, RunningProcess> = new Map();

  start(workflow: Workflow, callbacks: CLICallbacks): void {
    const cwd = workflow.worktreePath || process.cwd();
    const args = [
      "claude",
      "-p", workflow.specification,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];

    const proc = Bun.spawn(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const entry: RunningProcess = {
      process: proc,
      workflowId: workflow.id,
      sessionId: null,
      cwd,
      callbacks,
    };

    this.running.set(workflow.id, entry);
    this.streamOutput(entry);
  }

  sendAnswer(workflowId: string, answer: string): void {
    const entry = this.running.get(workflowId);
    if (!entry) return;

    // Kill current process and resume with answer
    entry.process.kill();
    this.running.delete(workflowId);

    const sessionId = entry.sessionId;
    if (!sessionId) {
      entry.callbacks.onError("No session ID available to resume conversation");
      return;
    }

    const args = [
      "claude",
      "-p", answer,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--resume", sessionId,
    ];

    const proc = Bun.spawn(args, {
      cwd: entry.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const newEntry: RunningProcess = {
      process: proc,
      workflowId,
      sessionId,
      cwd: entry.cwd,
      callbacks: entry.callbacks,
    };

    this.running.set(workflowId, newEntry);
    this.streamOutput(newEntry);
  }

  kill(workflowId: string): void {
    const entry = this.running.get(workflowId);
    if (entry) {
      entry.process.kill();
      this.running.delete(workflowId);
    }
  }

  killAll(): void {
    for (const entry of this.running.values()) {
      entry.process.kill();
    }
    this.running.clear();
  }

  private async streamOutput(entry: RunningProcess): Promise<void> {
    const { process: proc, callbacks, workflowId } = entry;
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") return;
    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            this.handleStreamEvent(entry, event);
          } catch {
            // Non-JSON line, treat as raw output
            callbacks.onOutput(line);
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          this.handleStreamEvent(entry, event);
        } catch {
          callbacks.onOutput(buffer);
        }
      }
    } catch (err) {
      // Stream read error
    }

    const exitCode = await proc.exited;
    const currentEntry = this.running.get(workflowId);

    // Only handle completion if this is still the active process
    if (currentEntry && currentEntry.process === proc) {
      this.running.delete(workflowId);
      if (exitCode === 0) {
        callbacks.onComplete();
      } else {
        const stderrStream = proc.stderr;
        const stderr = stderrStream && typeof stderrStream !== "number"
          ? await new Response(stderrStream as ReadableStream).text()
          : "";
        callbacks.onError(stderr.trim() || `CLI process exited with code ${exitCode}`);
      }
    }
  }

  private handleStreamEvent(entry: RunningProcess, event: any): void {
    // Extract session ID from the stream
    if (event.session_id && !entry.sessionId) {
      entry.sessionId = event.session_id;
      entry.callbacks.onSessionId?.(event.session_id);
    }

    // Handle different event types from stream-json format
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          entry.callbacks.onOutput(block.text);
        } else if (block.type === "tool_use") {
          entry.callbacks.onOutput(`[Tool: ${block.name}]`);
        }
      }
    } else if (event.type === "content_block_delta" && event.delta?.text) {
      entry.callbacks.onOutput(event.delta.text);
    } else if (event.type === "result" && event.result) {
      // Final result message
      if (event.session_id) {
        entry.sessionId = event.session_id;
      }
    }
  }
}
