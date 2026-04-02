# crab-studio Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-02

## Active Technologies
- TypeScript, Bun 1.2.12 (pinned in CI)
- `@anthropic-ai/sdk` (Haiku API for summaries and question classification)
- `@biomejs/biome` (linter + formatter)
- Bun.serve built-in (no web framework)
- In-memory only (no database; single workflow at a time)

## Project Structure

```text
src/              # Server + client source
tests/            # Bun test files
.github/          # CI workflows, Dependabot config
```

## Commands

```bash
bun install              # Install dependencies
bun test                 # Run tests
bun run tsc --noEmit     # Type check
bunx biome ci .          # Lint & format check (CI mode)
bunx biome check --write . # Auto-fix lint & format issues
bun audit                # Dependency vulnerability check
```

## Code Style

TypeScript: Enforced by Biome (`bunx biome ci .`)



<!-- MANUAL ADDITIONS START -->
- Make atomic and small commits!
- Every commit message MUST begin with one of the following prefixes:
  `feat:`, `chore:`, `bug:`, `docs:`.
- Messages MUST be short and concise — a few words describing what
  happened. No long explanations.
<!-- MANUAL ADDITIONS END -->
