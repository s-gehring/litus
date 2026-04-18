# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

## [1.3.0] — 2026-04-18

### Added

- Manual-mode feedback loop: a **Provide Feedback** action on the merge-PR pause lets you submit free-form feedback,
  which spawns a dedicated agent that applies it, commits with Conventional Commit messages, pushes, and optionally
  updates the PR description. Submitted feedback is persisted on the workflow, survives server restart, and is injected
  as authoritative context into every subsequent agent step — overriding spec/plan content on conflict.
- GitHub URL input for specs and epics — paste a repository URL alongside a local path in the new-spec or new-epic
  modal. Litus clones the repo under `~/.litus/repos` with a live clone-progress indicator, and multiple workflows
  against the same repo share a single managed clone that is cleaned up when the last workflow terminates.
- Alert queue: persistent alerts surface as toasts, a bell icon in the header with a full alert list, and a red dot
  on the favicon. Fires on questions asked, PRs opened in manual mode, finished standalone workflows, finished epics,
  and workflow errors. Clicking any alert deep-links to the corresponding workflow or epic. Alerts persist across
  server restarts.
- Workflow artifact viewer — per-step artifact dropdown on the workflow detail view lets you preview or download the
  spec, plan, tasks, review, and implement-review markdown in-app. Artifacts are snapshotted on step completion so
  they survive worktree deletion and can't be mutated by later steps.
- Active-model panel on the workflow detail view shows the current step's model and effort (e.g.
  `Model: Default (Opus 4.7) - Effort: Medium`). The default Claude model is auto-detected at server start.
- Repeatable-step history — when a step is reset, prior runs are archived and remain visible in the step detail view
  instead of being discarded.
- `xhigh` effort level (rendered as "Extra High") available per-step alongside low / medium / high / max.
- URL-based navigation — dashboard, workflow detail, epic detail, and config are now separate routes
  (`/`, `/workflow/:id`, `/epic/:id`, `/config`). Deep links and browser back / forward work consistently.
- "Back to epic" breadcrumb button on workflows opened from an epic, showing the epic title.
- Thinking indicator shown while awaiting agent output.

### Changed

- Default epic-decomposition prompt rewritten to produce self-contained, independently verifiable specs and to fold
  pure-scaffolding specs into their first consumer.
- Default merge-conflict-resolution prompt tightened — forbids `git merge --abort`, `git reset --hard`, and
  `git rebase --abort`, and requires the session to end with a new commit. Applied to fresh installs only; existing
  users keep their customized prompt unless they reset it from the config panel.
- `timing.maxCiLogLength` default raised from 50,000 to 200,000 characters — the fix-CI agent now sees more context
  on long runs.
- Alerts show the workflow summary or spec title instead of a short workflow hash.
- Tooltips now position relative to the viewport so they stay on-screen, and long field values are truncated per-field
  rather than truncating the whole tooltip.
- Clarify questions are de-duplicated so the detector cannot re-fire the same prompt.
- Tool-call icons in the output window now persist across pause and page reload.
- Server logs are prefixed with ISO timestamps for easier triage.

### Fixed

- Paused workflows no longer silently advance to the next step when an async callback (question classification,
  spec-kit init, merge, sync) resolves after the pause.
- Pausing during the merge-PR step no longer restarts CI polling behind the paused workflow.
- Merge-conflict resolution no longer enters a silent no-op loop that consumed every merge attempt when the agent
  aborted the merge or when the branch was already up to date. Merge outcomes are now classified, "already up to date"
  is retried once without consuming an attempt, and unrecoverable cases surface an actionable error.
- Submitting a workflow with a local folder path that happens to point at a managed clone now attaches to that
  clone's reference count, so aborting one workflow can no longer delete the folder out from under another.
- Fix-CI step no longer fails on Windows with `ENAMETOOLONG` when the concatenated failure logs are long — logs are
  written to a temp file instead of being embedded in the spawned command line.
- Feedback modal now closes when you navigate away from the workflow that opened it.
- Config-save failures are surfaced to the client instead of being silently swallowed.

## [1.2.0] — 2026-04-11

### Added

- Dedicated config page with client-side routing between dashboard and settings
- Auto-install speckit during setup — no manual installation required
- Three-state auto-mode (off, auto-answer, full-auto) replacing the simple on/off toggle

### Fixed

- Docker: fixed read-only mount, git safe directory warnings, and gitignore handling

## [1.1.1] — 2026-04-10

### Fixed

- Skip GitHub release creation if one already exists for the tag
- Docker image fixes and runtime tool installation

### Changed

- Gate releases on CHANGELOG.md entry

## [1.1.0] — 2026-04-09

### Added

- Official Docker image published to GHCR with cosign-signed attestations
- Automated GitHub Releases with downloadable tarballs on every tagged version
- Container vulnerability scanning via Trivy

## [1.0.0] — 2026-04-08

First public release.

### Core

- 13-step pipeline: setup, specify, clarify, plan, tasks, implement, review, fix-review, create-pr, monitor-ci, fix-ci,
  merge, sync
- Real-time agent output streaming via WebSocket
- Question detection (regex pre-filter + Haiku classification) with in-browser answering
- Pause, resume, and abort workflow controls
- Session resume — agent picks up where it left off across server restarts
- Periodic progress summaries generated via Claude CLI

### Epics

- Epic decomposition — submit a high-level feature, get structured specs with dependency tracking
- Dependency-ordered execution with parallel scheduling where possible
- Epic tree visualization with per-spec status

### Git & CI integration

- Git worktree isolation — every workflow runs in its own worktree
- PR creation, CI monitoring (GitHub Actions polling with exponential backoff), and squash-merge
- CI failure auto-fix with configurable retry limits
- Conflict resolution with automatic commit and push

### Configuration

- Per-step model, effort level, and prompt configuration from the UI
- Configurable retry limits, poll intervals, idle timeouts, summary frequency
- Auto-mode toggle for unattended operation
- Config persisted to `~/.litus/config.json`

### Frontend

- Vanilla TypeScript client — no framework dependencies
- Multi-workflow card strip with expand/collapse
- Pipeline step indicators with click-to-view history
- Rich tool usage tooltips showing input parameters
- Markdown rendering with DOMPurify sanitization
- Favicon notification dot for background tab awareness
- Folder picker dropdown for target repository selection

### Infrastructure

- Workflow state persistence with atomic writes and index management
- JSONL audit logging for all pipeline events, questions, and answers
- Setup validation (git, gh, Claude CLI, speckit skills, gitignore compliance)
- Bundled speckit review skills for the specify → implement pipeline
- Dependabot for npm and GitHub Actions dependencies
- CI pipeline: type check, lint, build, test, dependency audit
