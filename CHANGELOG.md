    f# Changelog

All notable changes to this project will be documented in this file.

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
