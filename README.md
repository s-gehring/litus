<p align="center">
  <img src="public/logo.svg" alt="Litus" width="80" height="80">
</p>

<h1 align="center">Litus</h1>

<p align="center">
  <strong>A web-based orchestrator for Claude Code agents.</strong><br>
  Welcome to <em>vibe code hell</em>.
</p>

<p align="center">
  <a href="https://github.com/s-gehring/litus/actions"><img src="https://github.com/s-gehring/litus/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/runtime-Bun%201.2.12+-f472b6" alt="Bun">
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6" alt="TypeScript">
  <img src="https://img.shields.io/badge/framework-none-lightgrey" alt="No framework">
</p>

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Litus — workflow running with live agent output" width="900">
</p>

---

Submit a feature spec, watch a Claude Code agent work through it step-by-step in your browser, answer its questions when
it gets stuck, and end up with a merged PR. Litus handles the entire lifecycle — from specification to CI green to
merge — so you can focus on the parts that actually need a human brain.

## Features

- **13-step pipeline** — Specify, clarify, plan, implement, review, create PR, monitor CI, fix failures, merge. All
  automated, all observable.
- **Real-time streaming** — Agent output streams to the browser via WebSocket. You see what the agent sees, as it
  happens.
- **Question detection** — When the agent needs input, Litus catches it (regex + Haiku classification) and surfaces it
  in the UI. You answer, it resumes.
- **Epic decomposition** — Got a big feature? Submit it as an epic. Litus breaks it into specs with dependency tracking
  and runs them in the right order.
- **Git worktree isolation** — Every workflow runs in its own worktree. Your main branch stays pristine. You're welcome.
- **CI monitoring & auto-fix** — Watches GitHub Actions, pulls failure logs, and lets the agent fix what it broke.
  Configurable retry limits.
- **Pause, resume, abort** — Full lifecycle control. Session IDs are preserved, so the agent picks up right where it
  left off.
- **Configurable everything** — Models, effort levels, prompts, retry limits, timeouts. Per-step. From the UI.
- **Periodic summaries** — Short progress summaries generated every 15 seconds via the CLI so you don't have to read the
  full output stream.
- **Audit logging** — Every question, answer, commit, and pipeline event is logged to JSONL.

## Screenshots

|                                                            |                                                           |
|------------------------------------------------------------|-----------------------------------------------------------|
| ![Epic tree view](docs/screenshots/epic-tree.png)          | ![New specification modal](docs/screenshots/new-spec.png) |
| Epic decomposition with dependencies                       | Creating a new specification                              |
| ![Pipeline running](docs/screenshots/pipeline-running.png) | ![Question panel](docs/screenshots/question-panel.png)    |
| Pipeline in progress with live output                      | Agent asking a question                                   |

## How to use

1. You enter a feature spec in the browser and hit **Start**
2. Litus creates a git worktree and spawns `claude -p <spec> --output-format stream-json`
3. The agent works through the pipeline: specify → clarify → plan → implement → review → PR → CI → merge
4. When the agent asks a question, it's surfaced in the UI — you answer, the session resumes
5. When CI fails, the agent reads the logs and tries to fix it (up to your configured limit)
6. When everything's green, Litus squash-merges the PR and cleans up

### The pipeline

| Step           | Actor          | What happens                                              |
|----------------|----------------|-----------------------------------------------------------|
| **Setup**      | Litus          | Validates repo, git, GitHub CLI, auth, speckit skills     |
| **Specify**    | Claude         | Formalizes your description into a structured spec        |
| **Clarify**    | Claude + Human | Resolves ambiguities in the spec                          |
| **Plan**       | Claude         | Creates a technical design                                |
| **Tasks**      | Claude         | Generates a task checklist                                |
| **Implement**  | Claude         | Writes the code                                           |
| **Review**     | Claude         | Self-critiques the implementation                         |
| **Fix Review** | Claude         | Addresses review findings (loops if critical/major)       |
| **Create PR**  | Claude         | Commits, pushes, opens a GitHub PR                        |
| **Monitor CI** | Litus          | Polls GitHub Actions with exponential backoff             |
| **Fix CI**     | Claude + Litus | Reads failure logs, attempts fixes (configurable retries) |
| **Merge PR**   | Litus          | Squash-merges the PR                                      |
| **Sync Repo**  | Litus          | Pulls changes and cleans up the worktree                  |

## Getting started

### Prerequisites

| Tool                                                                                                                | Why                                                                                                     |
|---------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| [Bun](https://bun.sh) >= 1.2.12                                                                                     | Runtime. Fast, TypeScript-native, no transpilation ceremony.                                            |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code)                                                       | The CLI agent that does the actual work. Must be installed and authenticated.                           |
| [GitHub CLI (`gh`)](https://cli.github.com/)                                                                        | PR creation, CI monitoring, merge operations. Must be authenticated.                                    |
| [Speckit](https://github.com/github/spec-kit) ([MIT License](https://github.com/github/spec-kit/blob/main/LICENSE)) | Claude Code slash commands for the specify → implement pipeline. Must be installed in your target repo. |

### Install and run

```bash
# Clone
git clone https://github.com/s-gehring/litus.git
cd litus

# Install dependencies
bun install

# Build client + start server with hot reload
bun run dev
```

Open [http://localhost:3000](http://localhost:3000). Override with the `PORT` env var.

For production (client must be pre-built):

```bash
bun run start
```

### Quality checks

```bash
bun test                       # Run tests
bun run tsc --noEmit           # Type check
bunx biome ci .                # Lint & format (CI mode)
bunx biome check --write .     # Auto-fix lint & format
bun audit                      # Dependency vulnerability scan
```

## Configuration

Click the gear icon in the header to open the config panel. Everything is configurable per-step:

- **Models** — Choose which Claude model to use for each pipeline step
- **Effort levels** — `low`, `medium`, `high`, or `max` per step
- **Prompts** — Customize question detection and review classification prompts
- **Limits** — Max review iterations, CI fix attempts, merge retries
- **Timing** — Poll intervals, idle timeouts, summary frequency
- **Auto Mode** — Skip optional checks and auto-answer questions (for the brave)

Config is persisted to `~/.litus/config.json`.

## Epics

For features too large for a single workflow, Litus supports **epics**:

1. Click **New Epic** and describe the feature at a high level
2. Litus decomposes it into individual specs with dependency tracking
3. Specs execute in dependency order and as parallel as possible — downstream workflows wait for their blockers to
   complete
4. The epic tree view shows the full dependency graph and per-spec status

## Data storage

All data lives under `~/.litus/`:

```
~/.litus/
  config.json                  # App configuration
  workflows/
    index.json                 # Workflow index
    {id}.json                  # Individual workflow state
    epics.json                 # Epic definitions
  audit/
    events.jsonl               # Audit log
```

## Tech stack

| Layer    | Technology                                                                                                                     |
|----------|--------------------------------------------------------------------------------------------------------------------------------|
| Runtime  | [Bun](https://bun.sh)                                                                                                          |
| Server   | `Bun.serve()` — built-in HTTP + WebSocket, no framework                                                                        |
| Agent    | [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) via `Bun.spawn` — no API key needed beyond what the CLI uses |
| Frontend | Vanilla TypeScript — no React, no Vue, no regrets                                                                              |
| Markdown | [marked](https://github.com/markedjs/marked) + [DOMPurify](https://github.com/cure53/DOMPurify)                                |
| Linting  | [Biome](https://biomejs.dev)                                                                                                   |
| Testing  | Bun test runner + [happy-dom](https://github.com/nicedayfor/happy-dom)                                                         |
| CI       | GitHub Actions                                                                                                                 |

## Related tools

Litus orchestrates a few external tools. Here's what they do and where to find them:

### [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

Anthropic's CLI for Claude. This is the actual agent that reads your code, writes implementations, and creates PRs.
Litus spawns it as a child process and communicates via `--output-format stream-json`. **All AI interactions go through
the CLI** — Litus has zero direct API calls, so there's no extra API cost beyond your normal Claude Code usage. Think of
Litus as the control tower and Claude Code as the plane.

### [GitHub CLI (`gh`)](https://cli.github.com/)

GitHub's official CLI. Litus uses it for PR creation, CI status polling, failure log retrieval, and squash-merge
operations. You'll need it installed and authenticated (`gh auth login`).

### [Speckit](https://github.com/example/speckit)

A set of Claude Code [skills](https://docs.anthropic.com/en/docs/claude-code/skills) that power the
specify → implement pipeline. These live in your target repository's `.claude/skills/` directory and give the agent
structured prompts for each pipeline step. Without speckit, Litus doesn't know what to tell the agent to do.

## Contributing

1. Fork the repo
2. Create a feature branch (`feat/your-thing`)
3. Make your changes — keep commits atomic and small
4. Commit messages must start with `feat:`, `bug:`, `chore:`, or `docs:`
5. Run `bunx biome ci .` and `bun test` before pushing
6. Open a PR against `master`

Linting is enforced by Biome. CI will reject anything that doesn't pass `biome ci`, type checking, and tests. Don't
fight it.

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).

This project utilizes AI products to generate code. The outputs of these tools are not covered by the AGPL license.
The authors of this software do not claim any ownership rights
over the code or other artifacts generated by the software.
