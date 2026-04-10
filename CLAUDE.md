# Litus Development Guidelines

## Tech Stack

- TypeScript, Bun (pinned in CI)
- Bun.serve (HTTP/WebSocket, no web framework)
- Claude Code CLI via `Bun.spawn` for agent execution
- `marked` + `dompurify` for markdown rendering and sanitization
- `@biomejs/biome` for linting + formatting

## Data & Persistence

- JSON files at `$HOME/.litus/workflows/` (one per workflow + `index.json`)
- Epic specs at `$HOME/.litus/workflows/epics.json`
- App config at `$HOME/.litus/config.json` (atomic writes)
- Audit logs at `$HOME/.litus/audit/` (JSONL)
- In-memory state resets on server restart

## Project Structure

```text
src/                    # Server + client source
  client/               # Browser client (vanilla TS, no framework)
    components/         # UI component modules
  server.ts             # HTTP/WS server entry point
  pipeline-orchestrator.ts  # Multi-step workflow execution
  workflow-engine.ts    # Workflow state machine + worktree management
  cli-runner.ts         # Claude Code CLI process management
  types.ts              # Shared type definitions
tests/                  # Bun test files
  test-infra/           # Shared mocks, factories, helpers
  unit/                 # Unit tests
  integration/          # Integration tests
public/                 # Static files (HTML, CSS, bundled JS)
.github/                # CI workflows, Dependabot config
```

## Commands

```bash
bun install              # Install dependencies
bun run dev              # Build client + start server with --watch
bun run start            # Production server (requires pre-built client)
bun test                 # Run tests
bun run tsc --noEmit     # Type check
bunx biome ci .          # Lint & format check (CI mode)
bunx biome check --write . # Auto-fix lint & format issues
bun audit                # Dependency vulnerability check
```

## Code Style

TypeScript: Enforced by Biome (`bunx biome ci .`)

- Make ATOMIC and small commits, and make them OFTEN!
- Follow [Conventional Commits](https://www.conventionalcommits.org).
  Common prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`.
- Messages MUST be short and concise — a few words describing what
  happened. No long explanations.
- DO NOT COMMIT ANYTHING THAT IS GITIGNORED!! No git add -f
- Every github action must be SHA pinned
- Do not create bullet points for "Test Plan" on opening pull requests.

## Active Technologies
- TypeScript (strict), Bun runtime + None new — vanilla TS, `marked` + `dompurify` (existing) (034-config-page-router)
- JSON files at `$HOME/.litus/` (existing, unchanged) (034-config-page-router)

## Recent Changes
- 034-config-page-router: Added TypeScript (strict), Bun runtime + None new — vanilla TS, `marked` + `dompurify` (existing)
