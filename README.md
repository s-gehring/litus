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
  <a href="https://github.com/s-gehring/litus/pkgs/container/litus"><img src="https://img.shields.io/badge/docker-ghcr.io-2496ed" alt="Docker"></a>
  <img src="https://img.shields.io/badge/runtime-Bun%20v1.3.11+-a04817c" alt="Bun">
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6" alt="TypeScript">
  <img src="https://img.shields.io/badge/framework-none-lightgrey" alt="No framework">
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License"></a>
</p>

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Litus — workflow running with live agent output" width="900">
</p>

---

Submit a feature spec, watch a Claude Code agent work through it step-by-step in your browser, answer its questions when
it gets stuck, and end up with a merged PR. Litus handles the entire lifecycle — from specification to CI green to
merge — so you can focus on the parts that actually need a human brain.

## Table of contents

- [What you can do with it](#what-you-can-do-with-it)
- [Demo](#demo)
- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
    - [From source](#from-source)
    - [Docker](#docker)
- [Workflow kinds](#workflow-kinds)
    - [Spec workflow](#spec-workflow-the-default)
    - [Quick Fix](#quick-fix)
    - [Epic](#epic)
    - [Ask Question](#ask-question)
- [Pipeline reference](#pipeline-reference)
- [Manual-mode feedback loop](#manual-mode-feedback-loop)
- [Configuration](#configuration)
- [Data storage](#data-storage)
- [Related tools](#related-tools)
- [Development](#development)
- [License](#license)

## What you can do with it

- **Ship a single feature** — Describe it, hit start. Litus walks Claude through specify → clarify → plan → implement
  → review → PR → CI → merge without manual intervention.
- **Decompose an epic** — Submit a high-level feature; Litus breaks it into individual specs with dependency tracking
  and runs them in dependency order, in parallel where possible.
- **Apply a one-off fix** — The **Quick Fix** workflow skips spec/plan and runs a lightweight fix-implement →
  PR → CI → merge pipeline for small, scoped changes.
- **Research a question** — The **Ask Question** workflow decomposes a question into research aspects, dispatches
  parallel research streams, and synthesizes a single answer with per-aspect findings as artifacts.
- **Stay in the loop when needed** — When the agent hits ambiguity, the question surfaces in the UI. Answer it,
  the session resumes. In manual mode you also get a feedback gate before merge.
- **Recover from CI failures** — Litus polls GitHub Actions, reads failure logs on red, and re-spawns Claude with
  the failure context up to your configured retry limit.
- **Run multiple workflows in parallel** — Each workflow runs in its own git worktree against the target repo,
  isolated from your main branch and from other workflows.
- **Inspect everything** — Live agent output streaming, per-step model/effort, artifact dropdown for spec/plan/
  review/implementation files, and a workflow archive for finished work.

## Demo

All clips below are captured straight from the project's Playwright e2e suite — see
[Regenerating demo recordings](#regenerating-demo-recordings) for how to produce or refresh them.

<table>
<tr>
<td width="50%" valign="top">

**Happy-path: spec → merged PR**

End-to-end run of a single specification through every pipeline step (specify → clarify → plan → tasks → implement →
review → artifacts → PR → CI → merge), including a clarifying question and a manual merge confirmation.

<video src="docs/demos/happy-path.webm" controls width="100%" muted playsinline>
  <a href="docs/demos/happy-path.webm">▶ docs/demos/happy-path.webm</a>
</video>

</td>
<td width="50%" valign="top">

**Mid-run question handling**

The agent stops mid-pipeline, surfaces a clarifying question in the UI, the operator answers, and the session
resumes — no separate chat window, no lost context.

<video src="docs/demos/mid-run-question.webm" controls width="100%" muted playsinline>
  <a href="docs/demos/mid-run-question.webm">▶ docs/demos/mid-run-question.webm</a>
</video>

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Quick Fix workflow**

Lightweight pipeline (fix-implement → commit-push-pr → monitor-ci → merge-pr → sync-repo) for small scoped fixes
that don't need a full spec/plan/implement cycle.

<video src="docs/demos/quick-fix.webm" controls width="100%" muted playsinline>
  <a href="docs/demos/quick-fix.webm">▶ docs/demos/quick-fix.webm</a>
</video>

</td>
<td width="50%" valign="top">

**Manual-mode feedback loop**

At the merge-PR pause an operator submits free-form feedback; a dedicated agent applies it, commits, pushes, and
the loop returns to the same merge-pause for another round.

<video src="docs/demos/review-feedback.webm" controls width="100%" muted playsinline>
  <a href="docs/demos/review-feedback.webm">▶ docs/demos/review-feedback.webm</a>
</video>

</td>
</tr>
</table>

## Screenshots

<table>
<tr>
<td><img src="docs/screenshots/new-spec.png" alt="New specification modal"></td>
<td><img src="docs/screenshots/pipeline-running.png" alt="Pipeline in progress"></td>
</tr>
<tr>
<td align="center"><sub>Submitting a new specification against a target repository</sub></td>
<td align="center"><sub>Workflow detail view with the pipeline mid-run</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/question-panel.png" alt="Agent question panel"></td>
<td><img src="docs/screenshots/epic-tree.png" alt="Epic dependency graph"></td>
</tr>
<tr>
<td align="center"><sub>The agent surfaces a clarifying question in-app — answer to resume</sub></td>
<td align="center"><sub>Epic decomposed into specs with a dependency-ordered execution graph</sub></td>
</tr>
</table>

## Quick start

```bash
# Native (recommended for development)
git clone https://github.com/s-gehring/litus.git
cd litus
bun install
bun run dev               # Build client + start server with hot reload
```

```bash
# Docker (recommended for actual use)
docker run -d \
  -p 3000:3000 \
  -e ANTHROPIC_API_KEY \
  -e GH_TOKEN \
  -v litus-data:/home/litus/.litus \
  ghcr.io/s-gehring/litus:latest
```

Open <http://localhost:3000> and submit a workflow against any GitHub URL — Litus clones the repo into the container
automatically. The full Docker recipe (credential mounting, env vars, optional local-repo bind-mounts) is in
[Installation → Docker](#docker) below.

> [!CAUTION]
> Litus runs Claude Code with `--dangerously-skip-permissions`, meaning the agent can read, write, and delete files
> without asking. It also creates PRs and merges them to your main branch automatically. This can introduce bugs into
> production systems or cause data loss. **Only run Litus in sandboxed environments or against repositories where you
> are comfortable with autonomous, unsupervised changes.**

## Prerequisites

| Tool                                                          | Why                                                                                                                                                                                           |
|---------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| [Bun](https://bun.sh) >= 1.3.11                               | Runtime. Fast, TypeScript-native, no transpilation ceremony.                                                                                                                                  |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | The CLI agent that does the actual work. Must be installed and authenticated.                                                                                                                 |
| [GitHub CLI (`gh`)](https://cli.github.com/)                  | PR creation, CI monitoring, merge operations. Must be authenticated with permission to merge PRs without reviews.                                                                             |
| [uv](https://docs.astral.sh/uv/)                              | Python package runner. Required so Litus can auto-install [speckit](https://github.com/github/spec-kit) skills into target repos that don't have them yet. Pre-installed in the Docker image. |

### Prepare the target repository

Litus runs Claude Code agents against a **target repository** — the repo where code changes happen. The recommended
path is to submit a GitHub URL in the workflow modal: Litus clones the repo into a managed working directory and
keeps it isolated from anything else on disk.

For URL-sourced workflows you only need to make sure `gh` is authenticated for the target — the CLI is what creates
the PR, polls CI, and merges. If you'd rather point Litus at an existing local clone, ensure it has push access to
its upstream and is not a shallow clone (worktrees can't branch off a shallow clone).

> [!NOTE]
> Litus relies on [speckit](https://github.com/github/spec-kit) skills in the target repo. If they're missing, Litus
> auto-installs them via `uvx` during setup — make sure `uv` is on your `PATH`. The Docker image already includes it.

## Installation

### From source

```bash
git clone https://github.com/s-gehring/litus.git
cd litus
bun install
bun run dev               # Build client + start server with hot reload
```

For production (client must be pre-built):

```bash
bun run build:client
bun run start
```

Override the listen port via `PORT`. Default: `3000`.

### Docker

A pre-built image is published to the
[GitHub Container Registry](https://github.com/s-gehring/litus/pkgs/container/litus) on every release. The default
recipe runs Litus against repositories you submit by **GitHub URL** — Litus handles the clone inside the container,
so there's nothing host-side to mount beyond persistent state.

```bash
docker run -d \
  -p 3000:3000 \
  -e ANTHROPIC_API_KEY \
  -e GH_TOKEN \
  -v litus-data:/home/litus/.litus \
  ghcr.io/s-gehring/litus:latest
```

`litus-data` is a named volume holding workflow state, epics, config, audit logs, the archive, and managed clones —
so the container can be replaced or upgraded without losing history. Open <http://localhost:3000>, click
**New Specification** (or **Quick Fix**, **New Epic**, **Ask Question**), paste a GitHub URL like
`https://github.com/owner/repo`, and go.

#### Claude Code authentication

The container ships with [Claude Code CLI](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)
installed globally. It needs valid credentials to call the Anthropic API.

**Option A — API key (recommended for containers)**

Pass `ANTHROPIC_API_KEY` via env, exactly as in the recipe above.

**Option B — Mount an existing Claude session**

If you've already authenticated with `claude` on the host, bind-mount the credentials directory instead of setting
`ANTHROPIC_API_KEY`:

```bash
docker run -d \
  -e GH_TOKEN \
  -v ~/.claude:/home/litus/.claude \
  -p 3000:3000 \
  -v litus-data:/home/litus/.litus \
  ghcr.io/s-gehring/litus:latest
```

> [!NOTE]
> Mounting `~/.config/gh` does **not** work for GitHub CLI authentication — most `gh` installations store the token in
> the OS keyring rather than in config files. Always use the `GH_TOKEN` environment variable.

#### Optional: working with a local clone

If you'd rather drive a workflow against a clone that already exists on the host (e.g. you want commits to land on
your live working tree, or the repo isn't on GitHub) instead of letting Litus manage one via URL, bind-mount it
under `/home/litus/repos/<name>` and reference that container path in the workflow modal. The named `litus-data`
volume still keeps history; the additional `-v` just exposes the local clone to the agent.

```bash
docker run -d \
  -p 3000:3000 \
  -e ANTHROPIC_API_KEY \
  -e GH_TOKEN \
  -v litus-data:/home/litus/.litus \
  -v ~/projects/my-app:/home/litus/repos/my-app \
  ghcr.io/s-gehring/litus:latest
```

You can stack as many `-v ~/projects/X:/home/litus/repos/X` flags as you need; the repo picker in the modal lists
whatever you've made visible.

#### Environment variables

| Variable            | Default | Description                                                                            |
|---------------------|---------|----------------------------------------------------------------------------------------|
| `ANTHROPIC_API_KEY` | —       | API key for Claude Code CLI (required unless you mount `~/.claude`)                    |
| `GH_TOKEN`          | —       | GitHub personal access token for `gh` CLI (required). `GITHUB_TOKEN` is also accepted. |
| `PORT`              | `3000`  | HTTP server listen port (inside the container)                                         |

#### Volumes

| Path                       | Purpose                                                                                                                                              |
|----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| `/home/litus/.litus`       | Workflow state, epic definitions, app config, audit logs, archive, and managed-repo clones. Mount a named or bind volume to persist across restarts. |
| `/home/litus/.claude`      | Optional. Bind-mount an existing Claude Code session directory instead of using `ANTHROPIC_API_KEY`.                                                 |
| `/home/litus/repos/<name>` | Optional. Bind-mount a local clone here to drive workflows against an existing host-side checkout instead of a GitHub URL.                           |

The entrypoint creates the required subdirectories (`workflows/`, `audit/`, `archive/`, `repos/`) and fixes ownership
on bind mounts.

## Workflow kinds

Litus supports four workflow kinds, each tuned for a different size of task.

### Spec workflow (the default)

![Spec pipeline steps](docs/screenshots/pipeline-spec.png)

The full pipeline: setup → specify → clarify → plan → tasks → implement → review → fix-review → artifacts →
commit-push-pr → monitor-ci → fix-ci → merge-pr → sync-repo.

Use this when you want a complete, structured implementation: the agent formalises your description into a spec,
asks clarifying questions, plans the work, generates a task list, implements it, self-reviews, captures artifacts
(test logs, screenshots, design notes), opens a PR, monitors CI, and merges. Submit via **New Specification**.

The specify → clarify → plan → tasks → implement → review → fix-review steps are powered by GitHub's
[speckit](https://github.com/github/spec-kit) skills (auto-installed into the target repo via `uvx` if missing).
Litus extends speckit with the surrounding lifecycle: a setup gate, an implementation-artifacts capture step, the
PR / CI / merge / sync steps, and a feedback loop that lets you nudge the agent at the merge pause.

### Quick Fix

![Quick Fix pipeline steps](docs/screenshots/pipeline-quick-fix.png)

A lightweight pipeline for small scoped changes: setup → fix-implement → commit-push-pr → monitor-ci → fix-ci →
merge-pr → sync-repo. Skips specify/clarify/plan/tasks/implement/review.

Use this for typo fixes, log-message tweaks, single-call-site changes, or anything where a full spec cycle is
overkill. Submit via **Quick Fix**. Provide Feedback works on errored fix-implement steps and re-enters the step
with your guidance.

### Epic

![Epic decomposition with child specs](docs/screenshots/pipeline-epic.png)

Decomposition of a high-level feature into individual spec workflows with dependency tracking. Submit a multi-spec
goal via **New Epic**; the analyzer breaks it into self-contained, independently verifiable specs and produces a
dependency graph. Specs run in dependency order, parallel where possible.

The epic detail view shows the full graph and per-spec status, plus batch controls (`Pause all`, `Resume all`,
`Abort all`) and a `Start N specs` button to launch every dependency-free child in one click.

If decomposition produces an unsatisfying breakdown, open the **Provide Feedback** panel on the epic, submit
guidance, and the analyzer re-runs from the prior session with your feedback applied. Feedback is blocked once any
child spec has started.

### Ask Question

![Ask Question modal](docs/screenshots/pipeline-ask-question.png)

A research workflow: submit a question against a target repository and Litus decomposes it into research aspects,
runs them as parallel research streams that each dig into one aspect, and synthesizes a single answer.

Per-aspect output streams live into a grid panel. Partial findings are saved as artifacts even if synthesis later
fails. Configurable decomposition / research / synthesis models and prompts; the per-workflow concurrency cap is
`askQuestionConcurrentAspects` (default 10). Submit via **Ask Question**.

## Manual-mode feedback loop

In **Manual** automation mode, Litus pauses before merging so you can review the PR. At that pause, you can:

- **Resume** — merge the PR as-is.
- **Provide Feedback** — type free-form feedback. Litus spins up a dedicated `feedback-implementer` agent that reads
  your feedback, makes the requested changes, commits with Conventional Commit messages, and pushes. When the change
  is materially relevant to the PR outcome, the agent also losslessly augments the PR description on GitHub.

After a feedback iteration lands commits, CI re-runs, and you return to the same merge-pause with the same choices —
iterate as many times as you need. The **Provide Feedback** button only appears in Manual mode.

## Configuration

Click the gear icon in the header to open the config panel. Everything is configurable per-step:

- **Models** — choose which Claude model each pipeline step uses (or leave empty to use the CLI default).
- **Effort levels** — `low`, `medium`, `high`, `xhigh` ("Extra High"), or `max` per step.
- **Prompts** — customise question detection, review classification, epic decomposition, merge-conflict resolution,
  ask-question decomposition / research / synthesis, and more.
- **Limits** — max review iterations, CI fix attempts, merge retries, ask-question concurrent aspects, artifact size
  caps.
- **Timing** — poll intervals, idle timeouts, summary frequency, summarizer timeout.
- **Auto Mode** — three states: off (manual pauses + manual question answering), auto-answer (auto-skip safe
  questions), full-auto (no pauses at all — for the brave).

Config is persisted to `~/.litus/config.json`. Mid-workflow config edits take effect on the next applicable step
(e.g. raising `ciFixMaxAttempts` immediately changes the budget on the next monitor-ci poll).

## Data storage

All data lives under `~/.litus/`:

```
~/.litus/
  config.json                  # App configuration
  workflows/
    index.json                 # Workflow index
    {id}.json                  # Individual workflow state (incl. archived)
    epics.json                 # Epic definitions
  audit/
    events.jsonl               # Audit log (JSONL, one event per line)
  repos/                       # Managed clones of URL-sourced workflows
  artifacts/{workflow-id}/     # Captured implementation artifacts
```

Litus handles application crashes and unexpected restarts gracefully. URL-sourced workflows share a single managed
clone via refcount — the clone is cleaned up when the last consumer terminates.

## Related tools

### [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

Anthropic's CLI for Claude. The actual agent that reads code, writes implementations, and creates PRs. Litus spawns
it as a child process and communicates via `--output-format stream-json`. **All AI interactions go through the CLI** —
Litus has zero direct API calls, so there's no extra API cost beyond your normal Claude Code usage. Think of Litus as
the control tower and Claude Code as the plane.

### [GitHub CLI (`gh`)](https://cli.github.com/)

GitHub's official CLI. Litus uses it for PR creation, CI status polling, failure log retrieval, and squash-merge
operations. You'll need it installed and authenticated (`gh auth login`).

### [Speckit](https://github.com/github/spec-kit)

A set of Claude Code [skills](https://docs.anthropic.com/en/docs/claude-code/skills) that power the
specify → implement pipeline. These live in your target repository's `.claude/skills/` directory and give the agent
structured prompts for each pipeline step. If speckit skills are missing from a target repo, Litus auto-installs them
via `uvx` during the setup step.

## Development

### Running locally

```bash
bun run dev                    # Build client + start server with --watch
```

### Quality checks

```bash
bun test                       # Unit + integration + client tests
bun run test:e2e               # Playwright browser tests
bun run tsc --noEmit           # Type check
bunx biome ci .                # Lint & format (CI mode)
bunx biome check --write .     # Auto-fix lint & format
bun audit                      # Dependency vulnerability scan
```

### Regenerating demo recordings

The demo videos in `docs/demos/` are recorded by the project's Playwright e2e suite. Local runs of
`bun run test:e2e` record `video.webm` for **every** test (passing or failing) under `tests/e2e/test-results/<test>/`.
To regenerate or add a demo, run the corresponding test and copy the resulting webm into `docs/demos/`:

```bash
# Run a single test (faster than the whole suite)
bunx playwright test -c tests/e2e/playwright.config.ts tests/e2e/tests/happy-path.e2e.ts

# Copy the recording into docs/demos/
cp tests/e2e/test-results/happy-path.e2e.ts-*chromium/video.webm docs/demos/happy-path.webm
```

Current mapping:

| Demo                    | Source test                                             |
|-------------------------|---------------------------------------------------------|
| `happy-path.webm`       | `tests/e2e/tests/happy-path.e2e.ts`                     |
| `mid-run-question.webm` | `tests/e2e/tests/mid-run-question.e2e.ts` (manual mode) |
| `quick-fix.webm`        | `tests/e2e/tests/quick-fix.e2e.ts`                      |
| `review-feedback.webm`  | `tests/e2e/tests/review-feedback-loop.e2e.ts`           |

### Contributing

1. Fork the repo
2. Create a feature branch (`feat/your-thing`)
3. Make your changes — keep commits atomic and small
4. Follow [Conventional Commits](https://www.conventionalcommits.org) for all commit messages (CI enforces this on PRs)
5. Run `bunx biome ci .` and `bun test` before pushing
6. Open a PR against `master`

Linting is enforced by Biome. CI will reject anything that doesn't pass `biome ci`, type checking, tests, or
conventional commit checks. Don't fight it.

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE.md).

This project utilizes AI products to generate code. The outputs of these tools are not covered by the AGPL license.
The authors of this software do not claim any ownership rights over the code or other artifacts generated by the
software.
