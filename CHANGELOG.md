# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Ask Question workflow — a new workflow kind. Submit a question against a target repository (local path or
  GitHub URL) and Litus decomposes it into research aspects, runs them as parallel research streams that each
  dig into one aspect, and synthesizes a single answer. Per-aspect output streams live into a grid panel;
  partial findings are saved as artifacts even if synthesis later fails. Supports a Provide-Feedback loop on
  the answer, configurable decomposition / research / synthesis models and prompts, and an
  `askQuestionConcurrentAspects` cap (default 10).
- Quick Fix pipeline — a lightweight workflow kind that skips spec / clarify / plan and runs
  setup → fix-implement → commit-push-pr → monitor-ci → fix-ci → feedback → merge-pr → sync-repo. Useful for
  small, scoped fixes. Per-step model, effort, and prompt configuration. Provide Feedback works on errored
  fix-implement steps and re-enters the step with your guidance.
- Implementation artifacts step — a new pipeline step (spec workflows only) inserted between implement-review
  and commit-push-pr. Runs the configured LLM with a manifest contract and captures arbitrary files (test logs,
  diffstats, screenshots, design notes…). Files are listed in the artifact dropdown with the LLM's description and
  previewed in-browser for images, plain text, JSON, and markdown; everything else falls back to download. Size and
  timeout caps are configurable from the UI with unit-aware inputs (MB / GB, min / hour). When the agent forgets
  `manifest.json` entirely, the output directory is scanned and every regular file is auto-collected.
- Workflow archive — workflows and epics in a terminal state can be archived from the action bar; archived items
  move to a dedicated archive page reachable from the header. Archiving an epic cascades to its children with a
  count-aware confirmation; running children block the cascade with a per-child list of offenders.
- Auto-archive — background sweeper auto-archives `completed` workflows and epics 30 seconds after they reach a
  terminal state. Errored / aborted / infeasible items and ask-question workflows are exempt; epics with
  non-terminal children are skipped so idle work waiting for a Start click is never archived. Runs an immediate
  pass on server start so a backlog drains on first launch. Manually unarchived items are exempt from the next sweep.
- Epic decomposition feedback — once a decomposition completes (including with infeasible notes), a Provide Feedback
  panel mirrors the spec feedback form. Submitting feedback resumes the decomposition agent from the prior session,
  applies your guidance, and re-runs the analysis. The epic detail page shows a feedback timeline below the
  description and a dismissible "prior context was lost" notice when the agent had to start fresh. Feedback is
  blocked once any child spec has started.
- Bulk-start specs from epic detail — a `Start N specs` button on the epic detail page launches every idle,
  dependency-free child spec in parallel. Singular / plural label tracks the count. Visible even before the epic
  record itself has finished loading.
- Workflow Restart — a destructive `Restart` action on a finished, aborted, or errored workflow resets it back to
  setup, clearing summary, flavor, feedback entries, active-work timer, and dependency overrides so the pipeline
  re-runs from scratch. Standalone (non-epic) workflows auto-relaunch on click.
- Workflow cards — per-kind visual styling (Spec, Quick Fix, Epic, Ask Question) with type badges and accent
  colours; running epics now have a glow-pulse border. New cards are prepended on creation so the newest appear first.
- Folder validation — the spec / quick-fix / epic creation modals now show a green `✓ Valid git repository`
  indicator on successful blur-time validation. Non-git folders are rejected at modal-time, matching the stricter
  check applied at submit. Quick Fix runs the same blur-time validation as spec / epic. Submit awaits any in-flight
  probe instead of silently aborting; a 5 s timeout on `/api/folder-exists` keeps a stuck probe from pinning the
  form open.
- Auto-seen alerts — the bell badge counts only unseen alerts. Answering a question, navigating to a finished
  workflow / epic, or emitting an alert while you are already on its target route flips the alert to seen; the
  row remains in the list, dimmed. Clicking an alert row removes it entirely. Seen state persists across server
  restarts. Workflow-error alerts are excluded from auto-seen and require explicit dismissal.
- Clear all alerts — button in the alerts panel.
- Project CLAUDE.md in spec worktrees — the main worktree's `CLAUDE.md` is appended to the speckit-generated
  `CLAUDE.md` so project conventions reach the agent. Re-runs are idempotent. Quick-fix workflows are unchanged.
- CLAUDE.md push guard — before `git push` and `gh pr create`, the assembled local `CLAUDE.md` is restored to its
  pre-branch state via a standalone `chore:` commit so PRs never carry Litus-assembled content. The assembled file
  is also marked `skip-worktree` so it can never be staged accidentally.
- Unified detail action bar — a single slot-based action bar on workflow and epic detail views. Pause is now the
  primary action; `Reset and retry` becomes `Restart`; `Force start` moves to the primary slot when waiting on
  dependencies. Archive is hidden until the workflow is in a terminal state. Abort and Restart use the in-app
  confirmation modal — never the native `confirm()` dialog. Buttons render in a fixed slot order
  (primary → secondary → destructive → finalize) with a vertical divider between sides.
- Batch controls on epic detail — `Pause all`, `Resume all`, and `Abort all` fan out to the child workflows that
  can react to each action.
- Header logo links to home — clicking the Litus logo or title returns to the dashboard via SPA navigation.

### Changed

- `limits.ciFixMaxAttempts` default raised from 3 to 10 so more CI failures are auto-fixed before giving up.
- CI fix attempt budget is refreshed from config on every monitor result, so raising the limit mid-workflow takes
  effect on the next poll instead of being frozen at workflow creation.
- Retrying a workflow after "CI checks still failing after N fix attempts" now resets the attempt budget to 0 and
  picks up the current config value, so retry is no longer refused immediately.
- Spec summary timeout raised from 30 s to 60 s — under epic fan-out load, single-call latency was growing past the
  original budget and silently dropping the flavor.
- Question content is no longer truncated at 2000 characters — long multi-paragraph questions render in full, and
  bulleted / numbered lists inside the question panel render with proper indentation.
- CI-monitor first poll now waits up to 90 s for GitHub to associate workflow runs with the head SHA before treating
  an empty `gh pr checks` result as "no CI configured", so newly-created PRs no longer skip CI on a fast first poll.
- Free-form answers at the CI-monitor pause are routed to the Fixing CI agent as guidance — previously only `retry`
  and `abort` were honoured and any other answer just looped against the same cancelled checks.
- Merge-conflict resolution streams tool usage and partial assistant text live and updates the active-model panel
  with the configured model + effort, matching the rest of the pipeline.
- Per-aspect research panels render tool usages as icon badges (matching the rest of the UI) and are pinned to a
  fixed 300 px height so panels don't jump as content streams.
- `gh pr create --fill` re-runs that find an existing PR for the branch now attach to it instead of failing — this
  unblocks workflow retries on branches that already opened a PR.
- Detail-view title falls back to `summary || specification`, so it never shows the previously selected workflow's
  title while the summarizer is still running.
- Activity summarizer no longer interprets agent output as a prompt addressed to itself — the text is wrapped in
  `<agent_output>` tags and the summarizer is told the content is opaque and may be truncated. Whitespace-only
  windows are skipped entirely.
- "Cancelled" workflow state is renamed `aborted` everywhere in the UI, WS protocol, and orchestrator — matching
  the Abort button. Existing on-disk state is migrated transparently on load. (GitHub Actions' own "cancelled"
  terminology is unchanged.)
- Errored workflows can now be aborted, releasing their managed clone. Error is no longer a one-way trap that
  pinned the shared repo clone indefinitely.
- Ask-question Finalize and Provide Feedback actions live in the standard detail-action bar; the synthesized answer
  is no longer pushed to the bottom of the viewport by an empty output-log area.

### Fixed

- Streamed assistant output is no longer duplicated in the output log — the cumulative assistant message and the
  intermediate deltas were both being forwarded, so every token appeared twice.
- Git command output is scoped to the originating workflow window — `git fetch origin master` from one workflow
  no longer appears in another workflow's output stream when two are running concurrently.
- The thinking indicator no longer spins while the active-invocation panel says "No model in use" during
  setup / merge / sync steps or in brief between-step windows.
- `sync-repo` no longer leaves the UI stuck on the thinking indicator with a non-functional Pause button after the
  worktree is removed. A duplicate post-completion broadcast was racing the in-memory orchestrator teardown and
  re-broadcasting a pre-completion state; the terminal broadcast now has a single owner.
- Errored workflows render their error message in a dedicated banner on the detail pane instead of forcing the
  operator to dig through the output log to find the failure.
- Workflow cwd-missing errors now surface as `Worktree directory missing: <path>` instead of `ENOENT: no such file
  or directory, uv_spawn 'claude'` falsely blaming the binary.
- Errored workflows retain their managed-clone refcount, so retrying after a step error no longer fails immediately
  with a missing-cwd error on URL-sourced workflows.
- `git worktree move` failures with `EBUSY` / `EACCES` / `EPERM` / "being used by another process" / "Permission
  denied" on Windows are retried up to 20 × 50 ms — common right after a CLI step exits because of lingering
  grandchildren and AV inline-scanning the just-written files.
- Resume after answering a second clarify question no longer fails with `No conversation found with session ID …`.
  The session id is held stable across resumed streams instead of being overwritten with a transient one.
- The active-model panel updates when answering a mid-pipeline question — previously the resume routed through a
  path that did not refresh the panel, so the UI kept displaying the model from the previous step.
- Switching from an epic to a spec no longer leaves the epic feedback textarea + buttons visible on the spec page,
  where they appeared to take feedback for the spec.
- Epic decomposition timer is reset on feedback restart, so the live timer no longer includes the idle window
  between the prior decomposition completing and the feedback being submitted.
- Epic-finished alert is suppressed during feedback-driven aborts of running children — these are not organic
  completions and the toast was misleading.
- The Epic detail's `Start N specs` button is no longer hidden during the brief WS race between `workflow:list`
  and `epic:list` arrival on connect, or for orphan epics whose record is missing from `epics.json`.
- Implementation artifacts step salvages already-written `manifest.json` + listed files when the CLI is killed
  (idle timeout, wall-clock timeout, non-zero exit), so the pipeline advances instead of looping on a
  "manifest missing" retry.
- Provide Feedback on quick-fix `fix-implement` errors now re-runs the step with the feedback as guidance —
  previously the feedback was ignored.
- The fix-implement step routes `AskUserQuestion` tool_use to `waiting_for_input` instead of mis-classifying it
  as an empty-diff error, so quick-fix flows that ask clarifying questions can be answered.
- Restart on a standalone (non-epic) workflow now auto-relaunches the pipeline on click — previously the workflow
  landed in `idle` with no UI control to leave it because the Start button only renders for epic-attached workflows.
- Aborted workflows can be retried — the orchestrator is re-registered after retry, even when partial worktree
  cleanup fails, so Start no longer falls through with a silent "Workflow not found".
- Implement-review iteration count matches the number of review files surfaced in Artifacts (was off by one), and
  the implement-review snapshot is no longer silently dropped because of the bumped iteration.
- Per-aspect research findings are snapshotted on every successful aspect run and reachable as artifacts even if
  the synthesis step later fails.
- Ask-question synthesizer reads aspect findings from disk via its own file tools rather than receiving them
  inlined into argv, so long research outputs no longer fail with `ENAMETOOLONG`.
- Auto-archive sweeper drains existing terminal records on server start instead of waiting a full `intervalMs`
  after launch, so a backlog of completed work clears on first sweep.
- Auto-archive no longer archives errored / aborted / infeasible workflows or epics — only `completed` items are
  eligible — and a completed epic with non-terminal children (idle specs waiting for a Start click) is skipped.
- Archive page navigates back to the overview when toggled off; archive button styling matches the rest of the
  header buttons.
- Config inputs are no longer wiped while you are typing — a `config:state` broadcast skips the focused input,
  select, or textarea. Numeric fields select their digits on focus so typing replaces the formatted display.
- Configured per-step model and effort are honoured on resume and on epic JSON-retry — were previously falling
  back to the default during those paths.
- Folder validation in the spec / quick-fix / epic modal rejects non-git folders, matching the stricter check at
  submit. Paths outside the home directory are reported as `permission_denied` without leaking whether they exist.
- Card-strip selection tracks the URL on every route change.
- Detail-view title falls back to the spec text when no summary exists (previously continued to show the
  previously-selected workflow's summary).
- CLAUDE.md is no longer accidentally committed by the spec branch — the assembled file is marked
  `skip-worktree` so it is invisible to `git status` / `git add -A` / `git commit -a`. The earlier guard
  remains in place as a defense-in-depth backstop.
- Pipeline prompts thread the `CLAUDE.md` header through `--append-system-prompt` so user prompts are not pushed
  off the first character — slash commands like `/speckit-*` are once again forwarded to the CLI as commands
  rather than literal text.
- Ask-question workflows mark per-aspect step status before archive / reset; finalize emits a no-op log line when
  there is nothing to snapshot; finalize is blocked while another finalize is in flight; per-step config is
  honoured after restart.

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
