# Litus

A web-based orchestrator for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI agents. Submit a task specification, watch the agent work in real time, and answer its questions -- all from a browser.

## Features

- **Real-time streaming** -- Agent output streams to the browser via WebSocket with delta batching
- **Question detection** -- Regex pattern matching with Haiku-based classification for uncertain cases; surfaces agent questions in a dedicated UI panel
- **Periodic summaries** -- Haiku generates short summaries of agent progress every 15 seconds
- **Conversation continuity** -- Answers are relayed back to the CLI via session resume, so the agent picks up right where it left off
- **Git worktrees** -- Each workflow runs in an isolated worktree

## How it works

```
Browser                     Server                      Claude Code CLI
  |                           |                              |
  |-- spec (WebSocket) ------>|                              |
  |                           |-- spawn claude -p spec ----->|
  |                           |<-- stream-json output -------|
  |<-- output deltas ---------|                              |
  |<-- summaries (Haiku) -----|                              |
  |                           |                              |
  |   [question detected]     |                              |
  |<-- question --------------|                              |
  |-- answer --------------->>|-- resume with answer ------->|
  |                           |<-- stream continues ---------|
  |<-- output deltas ---------|                              |
```

1. User enters a task spec in the browser and hits Start
2. Server creates a git worktree and spawns `claude -p <spec> --stream-json --verbose`
3. CLI output is parsed line-by-line; text is checked against question patterns
4. When a question is detected, it's sent to the UI for the user to answer
5. The user's answer resumes the CLI session (`claude -p <answer> --resume <sessionId>`)
6. In parallel, accumulated output is periodically summarized by Haiku

## Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh) 1.2.12+ |
| Server | Bun.serve (built-in HTTP + WebSocket) |
| AI summaries | Claude 3.5 Haiku via `@anthropic-ai/sdk` |
| Agent | Claude Code CLI |
| Frontend | Vanilla TypeScript, no framework |
| Linting | [Biome](https://biomejs.dev) |
| CI | GitHub Actions |

## Project structure

```
src/
  server.ts              # HTTP/WebSocket server, workflow orchestration
  workflow-engine.ts     # State machine, git worktree creation
  cli-runner.ts          # Claude Code CLI spawning & stream parsing
  question-detector.ts   # Regex patterns + Haiku classification
  summarizer.ts          # Periodic summary generation via Haiku
  types.ts               # Shared types
  static-files.ts        # Static file serving with path traversal prevention
  build.ts               # Client bundler entry point
  client/
    app.ts               # WebSocket client, event handling
    components/
      question-panel.ts  # Question UI
      workflow-window.ts # Status, output, and summary display
public/
  index.html             # Single-page app shell
  style.css              # Dark theme
tests/                   # Unit tests (Bun test runner)
```

## Getting started

### Prerequisites

- [Bun](https://bun.sh) >= 1.2.12
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- `ANTHROPIC_API_KEY` environment variable set (used for Haiku summaries)

### Install and run

```bash
# Install dependencies
bun install

# Build the client bundle and start the server with hot reload
bun run dev
```

The server starts on `http://localhost:3000` (override with `PORT` env var).

For production:

```bash
bun run start
```

### Quality checks

```bash
bun test                       # Run tests
bun run tsc --noEmit           # Type check
bunx biome ci .                # Lint & format (CI mode)
bunx biome check --write .     # Auto-fix lint & format issues
bun audit                      # Dependency vulnerability scan
```

## Design constraints

- **Single workflow at a time** -- This is an MVP; no concurrent execution
- **In-memory state** -- No database; state is lost on server restart
- **No automatic worktree cleanup** -- Worktrees must be cleaned up manually

## License

See [LICENSE](LICENSE) for details.
